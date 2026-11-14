import "server-only";
import { NextRequest, NextResponse } from "next/server";
import type { Keypair } from "@stellar/stellar-sdk";
import type { BatchPlanRequest, BatchPlanResponse, CloseApiStatus } from "@lumenwipe/sdk";
import { PlaygroundConfigError } from "./crypto";
import { isCronSecretConfigured } from "./cron-auth";
import {
  AccountBusyError,
  MM_SESSION_FLOOR_XLM,
  spendableXlm,
  withAccountLock,
  type AccountLockOptions,
} from "./market-maker";
import type { NativeBalance } from "./horizon-submit";
import { BATCH_PLANS_PER_DAY_PER_IP, SESSIONS_PER_DAY_PER_IP, type RateLimit } from "./rate-limit";
import { notConfiguredResponse } from "./route-helpers";
import {
  createdSessionBody,
  discardSession,
  draftSession,
  isDefinitiveRejection,
  refusedForFunds,
  sessionRecordOf,
  setupFundingXlm,
  type ApiConfig,
} from "./route-handlers";
import {
  parseBatch,
  resolvePlan,
  SCENARIOS,
  validateBatch,
  type ResolvedPlan,
  type ScenarioId,
} from "./scenarios";
import {
  PlaygroundStoreUnavailableError,
  isSessionId,
  sessionExpiresAt,
  type PlaygroundBatch,
  type PlaygroundSession,
  type SessionStore,
} from "./session-store";
import {
  buildBatchSdkSnippet,
  SdkSnippetInputError,
  snippetInputFromExpectation,
} from "./sdk-snippet";
import { expectationFromSession } from "./verify";
import { PlaygroundVerificationError } from "./verify-error";
import { networkStroops } from "./stroops";

// The batch close: two or three ordinary sessions created together, planned with one call to the
// API's batch endpoint, then closed one after another through each session's own routes. Nothing
// here signs a close transaction: every member closes through /api/session/[id]/demolish/round.

type Unavailable = ReadonlyMap<ScenarioId, string>;

/** One demo account the market maker creates, and what it starts with. */
export interface DemoFunding {
  publicKey: string;
  startingBalance: string;
}

export interface CreateBatchDeps {
  store: SessionStore;
  rateLimit: RateLimit;
  issuer: () => Keypair | null;
  mm: () => Keypair | null;
  /** The reaper's cron secret: without it nothing reclaims an abandoned member. */
  cronSecret: () => string | undefined;
  /** The market maker's XLM, read from the network. */
  marketMakerBalance: (publicKey: string) => Promise<NativeBalance>;
  /** Creates every demo account in one market maker transaction, so either all exist or none. */
  provisionDemos: (mm: Keypair, demos: readonly DemoFunding[]) => Promise<unknown>;
  /** How long a start waits for the market maker's other submissions; tests shorten it. */
  accountLock?: AccountLockOptions;
  encrypt: (secret: string) => string;
  unavailable: () => Unavailable | Promise<Unavailable>;
}

/**
 * Starts a batch. Every member counts against the caller's daily session limit, the market maker
 * must keep its floor after funding all of them, and every member's record is written before the
 * one transaction that creates their accounts, under the market maker's lock.
 */
export async function handleCreateBatch(
  req: NextRequest,
  deps: CreateBatchDeps
): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = undefined;
  }
  const closable = parseBatch(body);
  if (!closable) {
    return NextResponse.json(
      { error: "invalid_selection", message: "The batch could not be read." },
      { status: 400 }
    );
  }
  const parsed = validateBatch(closable, { unavailable: await deps.unavailable() });
  if (!parsed.ok) {
    return NextResponse.json(
      { error: "invalid_selection", message: parsed.message },
      { status: 400 }
    );
  }
  const { batch } = parsed;

  // Each member is a session: it draws a funded account from the market maker and writes a
  // custodial record, so each one counts against the same daily limit a single start does.
  for (let i = 0; i < batch.members.length; i++) {
    const limited = await deps.rateLimit(req, "session", SESSIONS_PER_DAY_PER_IP);
    if (limited) return limited;
  }

  const issuer = deps.issuer();
  const mm = deps.mm();
  if (!issuer || !mm || !isCronSecretConfigured(deps.cronSecret())) {
    return notConfiguredResponse();
  }

  let mmBalance: NativeBalance;
  try {
    mmBalance = await deps.marketMakerBalance(mm.publicKey());
  } catch (err) {
    console.error("[playground] market maker balance read failed", err);
    return NextResponse.json({ error: "provision_failed" }, { status: 502 });
  }
  const draw = Number(networkStroops(batch.fundingXlm)) / 10_000_000;
  if (spendableXlm(mmBalance) - draw < MM_SESSION_FLOOR_XLM) return refusedForFunds(deps.store);

  const drafts = batch.members.map(draftSession);
  const sessions: PlaygroundSession[] = [];
  const discardAll = () => Promise.all(sessions.map((s) => discardSession(deps.store, s)));
  try {
    for (const draft of drafts) {
      sessions.push(await deps.store.createSession(sessionRecordOf(draft, null, deps.encrypt)));
    }
  } catch (err) {
    await discardAll();
    if (err instanceof PlaygroundConfigError || err instanceof PlaygroundStoreUnavailableError) {
      return notConfiguredResponse();
    }
    throw err;
  }

  try {
    await withAccountLock(
      deps.store,
      mm.publicKey(),
      () =>
        deps.provisionDemos(
          mm,
          drafts.map((d) => ({
            publicKey: d.demo.publicKey(),
            startingBalance: setupFundingXlm(d.plan.steps),
          }))
        ),
      deps.accountLock
    );
  } catch (err) {
    const busy = err instanceof AccountBusyError;
    // An outcome the network did not answer may still land: every record stays for the reaper.
    if (busy || isDefinitiveRejection(err)) await discardAll();
    console.error(
      "[playground] batch demo accounts not created",
      { sessionIds: sessions.map((s) => s.id) },
      err instanceof Error ? err.name : "unknown"
    );
    return busy
      ? NextResponse.json({ error: "playground_busy" }, { status: 503 })
      : NextResponse.json({ error: "provision_failed" }, { status: 502 });
  }

  // Written once the members exist: should it fail, each member is still an ordinary indexed
  // session the reaper reclaims.
  let record: PlaygroundBatch;
  try {
    record = await deps.store.createBatch(sessions.map((s) => s.id));
  } catch (err) {
    console.error(
      "[playground] batch record not written; the reaper reclaims its members",
      { sessionIds: sessions.map((s) => s.id) },
      err instanceof Error ? err.name : "unknown"
    );
    return NextResponse.json({ error: "provision_failed" }, { status: 502 });
  }

  return NextResponse.json({
    batchId: record.id,
    blockedIndex: batch.blockedIndex,
    expiresAt: sessionExpiresAt(),
    members: drafts.map((draft, i) => ({
      ...createdSessionBody(sessions[i]!, draft, issuer, mm, null),
      label: memberLabel(draft.plan),
    })),
  });
}

/** What a member's mess holds, by its scenarios' names. */
function memberLabel(plan: ResolvedPlan): string {
  return plan.selection.scenarios
    .map(({ id }) => SCENARIOS.find((d) => d.id === id)?.label ?? id)
    .join(", ");
}

/** Loads a batch and every member, or the response the route sends instead. */
async function loadBatchMembers(
  store: SessionStore,
  id: string
): Promise<PlaygroundSession[] | NextResponse> {
  const notFound = NextResponse.json({ error: "batch_not_found" }, { status: 404 });
  if (!isSessionId(id)) return notFound;
  try {
    const batch = await store.loadBatch(id);
    if (!batch) return notFound;
    const members: PlaygroundSession[] = [];
    for (const memberId of batch.memberIds) {
      const session = await store.loadSession(memberId);
      if (!session) return NextResponse.json({ error: "session_not_found" }, { status: 404 });
      members.push(session);
    }
    return members;
  } catch (err) {
    if (err instanceof PlaygroundStoreUnavailableError) return notConfiguredResponse();
    throw err;
  }
}

export interface BatchPlanRouteDeps {
  store: SessionStore;
  rateLimit: RateLimit;
  api: () => ApiConfig;
  /** The market maker's public key, the sink every member closes into; null when unset. */
  sink: () => string | null;
  /** The API's batch plan for a configured API. */
  batchPlan: (
    apiUrl: string,
    apiKey: string
  ) => (body: BatchPlanRequest) => Promise<BatchPlanResponse>;
}

/** One member's line in the batch plan, from the API's answer for its address. */
export interface BatchPlanRow {
  index: number;
  address: string;
  status: CloseApiStatus;
  blockers: { code: string; message: string }[];
  estimatedTransactionCount: number | null;
}

const STATUSES: readonly CloseApiStatus[] = ["ready", "needs_decisions", "blocked", "complete"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The API's batch answer held to the batch's own members: exactly one result per member, found by
 * its address and never by its position, with only the fields the page shows. Null when the
 * answer names an address that is not a member, names one twice, or leaves one out.
 */
export function batchPlanRows(
  members: readonly PlaygroundSession[],
  response: unknown
): BatchPlanRow[] | null {
  if (!isRecord(response) || !Array.isArray(response.results)) return null;
  if (response.results.length !== members.length) return null;
  const byAddress = new Map<string, unknown>();
  for (const result of response.results) {
    if (!isRecord(result) || typeof result.address !== "string") return null;
    if (byAddress.has(result.address)) return null;
    byAddress.set(result.address, result.plan);
  }
  const rows: BatchPlanRow[] = [];
  for (const [index, member] of members.entries()) {
    const plan = byAddress.get(member.demoPublic);
    if (!isRecord(plan) || !Array.isArray(plan.blockers)) return null;
    const status = STATUSES.find((s) => s === plan.status);
    if (!status) return null;
    const blockers: BatchPlanRow["blockers"] = [];
    for (const b of plan.blockers) {
      if (!isRecord(b) || typeof b.code !== "string" || typeof b.message !== "string") return null;
      blockers.push({ code: b.code, message: b.message });
    }
    const execution = isRecord(plan.execution) ? plan.execution : {};
    const count = execution.estimatedTransactionCount;
    rows.push({
      index,
      address: member.demoPublic,
      status,
      blockers,
      estimatedTransactionCount: typeof count === "number" ? count : null,
    });
  }
  return rows;
}

/** Whether every mess step of the member's plan has run. */
function messDone(session: PlaygroundSession): boolean {
  return resolvePlan(session.selection).steps.every((s) =>
    session.completedMessSteps.includes(s.id)
  );
}

/**
 * The API's read-only plan for every member of a batch, in one call made with the playground's
 * key. Rate limited per caller, since each call spends that key on every member's read; answered
 * only once every member's mess has run, so the plan shows what the visitor saw built.
 */
export async function handleBatchPlan(
  req: NextRequest,
  id: string,
  deps: BatchPlanRouteDeps
): Promise<NextResponse> {
  const limited = await deps.rateLimit(req, "batch-plan", BATCH_PLANS_PER_DAY_PER_IP);
  if (limited) return limited;

  const members = await loadBatchMembers(deps.store, id);
  if (members instanceof NextResponse) return members;
  if (!members.every(messDone)) {
    return NextResponse.json({ error: "batch_not_ready" }, { status: 409 });
  }

  const { apiUrl, apiKey } = deps.api();
  const sink = deps.sink();
  if (!apiUrl || !apiKey || !sink) return notConfiguredResponse();

  let response: BatchPlanResponse;
  try {
    response = await deps.batchPlan(
      apiUrl,
      apiKey
    )({ addresses: members.map((m) => m.demoPublic), destination: sink });
  } catch (err) {
    console.error(
      "[playground] batch plan failed",
      { batchId: id },
      err instanceof Error ? err.name : "unknown"
    );
    return NextResponse.json({ error: "batch_plan_failed" }, { status: 502 });
  }
  const results = batchPlanRows(members, response);
  if (!results) return NextResponse.json({ error: "batch_plan_mismatch" }, { status: 502 });
  return NextResponse.json({ results }, { headers: { "cache-control": "no-store" } });
}

export interface BatchSdkSnippetRouteDeps {
  store: SessionStore;
  /** The market maker's and the issuer's public keys, from configuration; null when either is
   *  missing. */
  publicAccounts: () => { sink: string; issuer: string } | null;
}

/**
 * The SDK code for the batch's closes, each built from the same expectation its member's demolish
 * answers from. Only public keys are passed in.
 */
export async function handleBatchSdkSnippet(
  id: string,
  deps: BatchSdkSnippetRouteDeps
): Promise<NextResponse> {
  const members = await loadBatchMembers(deps.store, id);
  if (members instanceof NextResponse) return members;
  const accounts = deps.publicAccounts();
  if (!accounts) return notConfiguredResponse();
  try {
    const closes = members.map(
      (session) =>
        snippetInputFromExpectation(
          expectationFromSession(session, accounts.sink, accounts.issuer, null)
        ).close
    );
    return NextResponse.json(
      { snippet: buildBatchSdkSnippet({ network: "testnet", closes }) },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (err) {
    if (err instanceof PlaygroundVerificationError || err instanceof SdkSnippetInputError) {
      console.error("[playground] batch sdk snippet unavailable", { batchId: id }, err.message);
      return NextResponse.json({ error: "snippet_unavailable" }, { status: 500 });
    }
    throw err;
  }
}
