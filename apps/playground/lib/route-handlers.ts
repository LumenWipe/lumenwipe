import "server-only";
import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { Asset, Keypair, Operation, type xdr } from "@stellar/stellar-sdk";
import { PlaygroundConfigError } from "./crypto";
import {
  DEFAULT_CUSTOM_CONFIG,
  MAX_CUSTOM_DATA_ENTRIES,
  MAX_CUSTOM_TRUSTLINES,
  type PlaygroundCustomConfig,
  type PlaygroundMode,
  maxOfferCount,
  selectionForMode,
} from "./mess-plan";
import {
  closesToExchange,
  EXCHANGE_STAND_IN,
  LWDEMO_CODE,
  generateRandomSelection,
  helperRoleOf,
  isMessStepId,
  parseReplayCode,
  parseSelection,
  resolvePlan,
  validateSelection,
  type HelperRole,
  type MessStepDef,
  type ScenarioId,
  type ValidationResult,
} from "./scenarios";
import { isCronAuthorized, isCronSecretConfigured } from "./cron-auth";
import { runReaper, type ReaperDeps } from "./reaper";
import { TxSubmitError, type NativeBalance, type SignerState } from "./horizon-submit";
import { recordedListed, revokeRecordedAllowance, type AllowanceApi } from "./allowances";
import {
  AccountBusyError,
  MM_SESSION_FLOOR_XLM,
  spendableXlm,
  withAccountLock,
  type AccountLockOptions,
} from "./market-maker";
import {
  resolutionTransaction,
  retireRecipientOps,
  type MessContext,
  type ResolutionContext,
} from "./mess-builders";
import type { DemolishRoundResult, RunDemolishOptions } from "./demolish";
import { CREDENTIALS_PER_DAY_PER_IP, SESSIONS_PER_DAY_PER_IP, type RateLimit } from "./rate-limit";
import { actionResponse, loadSessionOrErrorResponse, notConfiguredResponse } from "./route-helpers";
import {
  readSessionState,
  runCleanup,
  runDemolishRound,
  runMessStep,
  runResolve,
  runRevokeAllowance,
  readSessionAllowances,
  type CleanupDeps,
  type DemolishRoundDeps,
  type RecycleResult,
  type ResolveDeps,
  type RevokeAllowanceDeps,
  type StateDeps,
} from "./session-actions";
import {
  PlaygroundStoreUnavailableError,
  sessionExpiresAt,
  type PlaygroundSession,
  type SessionExchange,
  type SessionStore,
} from "./session-store";
import { signingKeyOf, type SigningKey } from "./signing";
import { expectationFromSession } from "./verify";

// The playground's route handlers, with every side effect injected. Each app/api route file wires
// the production dependencies and calls one of these, so the request parsing, status mapping and
// ordering below are exercised by tests/unit/route-handlers.test.ts against a fake store and fake
// network clients. Route files themselves can only export Next's route fields, so this logic
// cannot live there and stay testable.

/** The server-held keys, read from the environment on each request. */
export interface PlaygroundKeys {
  issuer: () => Keypair | null;
  mm: () => Keypair | null;
}

export interface ApiConfig {
  apiUrl: string | undefined;
  apiKey: string | undefined;
}

export interface CreateSessionDeps extends PlaygroundKeys {
  store: SessionStore;
  rateLimit: RateLimit;
  /** The reaper's cron secret: without it nothing reclaims an abandoned session. */
  cronSecret: () => string | undefined;
  /** The market maker's XLM, read from the network. */
  marketMakerBalance: (publicKey: string) => Promise<NativeBalance>;
  /** Creates the demo account from the market maker with `startingBalance` XLM. */
  provisionDemo: (mm: Keypair, demoPublic: string, startingBalance: string) => Promise<unknown>;
  /** Creates `address` from the market maker when the network does not have it (the exchange
   *  stand-in, after a testnet reset); does nothing when it exists. */
  ensureExchangeAccount: (mm: Keypair, address: string) => Promise<unknown>;
  /** How long a start waits for the market maker's other submissions; tests shorten it. */
  accountLock?: AccountLockOptions;
  encrypt: (secret: string) => string;
  /** Scenarios this deployment cannot run, with the reason shown to the visitor. */
  unavailable: () => Unavailable | Promise<Unavailable>;
}

type Unavailable = ReadonlyMap<ScenarioId, string>;

export interface ScenariosRouteDeps {
  unavailable: () => Unavailable | Promise<Unavailable>;
}

export interface MessDeps extends PlaygroundKeys {
  store: SessionStore;
  encrypt: (secret: string) => string;
  decrypt: (payload: string) => string;
  executeMessStep: (step: MessStepDef, ctx: MessContext) => Promise<string>;
}

export interface DemolishRouteDeps extends PlaygroundKeys {
  store: SessionStore;
  api: () => ApiConfig;
  /** The fee account the API's sponsor pays from, from this deployment's configuration. */
  feeAccount: () => string | null;
  /** The API mediator's public key, from this deployment's configuration. */
  mediatorKey: () => string | null;
  decrypt: (payload: string) => string;
  /** Runs one round of the close (lib/demolish.ts `runDemolish`). */
  runDemolish: (opts: RunDemolishOptions) => Promise<DemolishRoundResult>;
}

export interface CleanupRouteDeps {
  store: SessionStore;
  mm: () => Keypair | null;
  issuer: () => Keypair | null;
  decrypt: (payload: string) => string;
  /** Whether the account is on the network; false only when Horizon says it is not. */
  exists: (publicKey: string) => Promise<boolean>;
  /** Merges `source` into `destination` on chain. */
  merge: (source: Keypair, destination: string) => Promise<unknown>;
  /** Signs and submits `ops` from `source`. */
  submit: (source: Keypair, ops: xdr.Operation[]) => Promise<unknown>;
}

export interface ResolveRouteDeps {
  store: SessionStore;
  decrypt: (payload: string) => string;
  /** Signs and submits `ops` from `source`; returns the hash. */
  submit: (source: Keypair, ops: xdr.Operation[]) => Promise<string>;
}

export interface AllowancesRouteDeps {
  store: SessionStore;
  api: () => ApiConfig;
  decrypt: (payload: string) => string;
  /** The API's allowance list, revoke builder and submit for a configured API. */
  allowanceApi: (apiUrl: string, apiKey: string) => AllowanceApi;
  /** The demo's live signers and thresholds, read from Horizon. */
  signerState: (address: string) => Promise<SignerState>;
}

export interface CredentialsDeps {
  store: SessionStore;
  rateLimit: RateLimit;
  decrypt: (payload: string) => string;
}

export interface StateRouteDeps {
  store: SessionStore;
  api: () => ApiConfig;
  /** The account reader for a configured API. */
  accountReader: (apiUrl: string, apiKey: string) => StateDeps["getAccount"];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const clamp = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === "number" ? Math.max(min, Math.min(max, value)) : fallback;

function parseMode(value: unknown): PlaygroundMode {
  return value === "light" || value === "full" || value === "custom" ? value : "standard";
}

/** The original size modes; out-of-range custom values are clamped as they always were. */
function legacyCustomConfig(raw: unknown): PlaygroundCustomConfig {
  if (!isRecord(raw)) return DEFAULT_CUSTOM_CONFIG;
  const trustlineCount = clamp(
    raw.trustlineCount,
    1,
    MAX_CUSTOM_TRUSTLINES,
    DEFAULT_CUSTOM_CONFIG.trustlineCount
  );
  const maxOffers = maxOfferCount(trustlineCount);
  return {
    trustlineCount,
    offerCount: clamp(
      raw.offerCount,
      0,
      maxOffers,
      Math.min(DEFAULT_CUSTOM_CONFIG.offerCount, maxOffers)
    ),
    dataEntryCount: clamp(
      raw.dataEntryCount,
      0,
      MAX_CUSTOM_DATA_ENTRIES,
      DEFAULT_CUSTOM_CONFIG.dataEntryCount
    ),
    addSigner: typeof raw.addSigner === "boolean" ? raw.addSigner : DEFAULT_CUSTOM_CONFIG.addSigner,
  };
}

/**
 * Reads the scenario selection from a create request and validates it: a replay code (`seed`), an
 * explicit `selection`, or else one of the original modes.
 */
export function parseCreateBody(
  body: unknown,
  unavailable: ReadonlyMap<ScenarioId, string> = new Map()
): ValidationResult {
  // A seed is regenerated here, with this deployment's availability: whatever the client derived
  // from it is not trusted, and an edited code still lands inside the caps.
  if (isRecord(body) && body.seed !== undefined) {
    const code = typeof body.seed === "string" ? parseReplayCode(body.seed) : null;
    const selection =
      code && generateRandomSelection(code.seed, { version: code.version, unavailable });
    if (!selection) return { ok: false, message: "The replay code could not be read." };
    return validateSelection(selection, { unavailable });
  }
  if (isRecord(body) && body.selection !== undefined) {
    const selection = parseSelection(body.selection);
    if (!selection) return { ok: false, message: "The scenario selection could not be read." };
    return validateSelection(selection, { unavailable });
  }
  const mode = isRecord(body) ? parseMode(body.mode) : "standard";
  const custom =
    mode === "custom" && isRecord(body)
      ? legacyCustomConfig(body.customConfig)
      : DEFAULT_CUSTOM_CONFIG;
  return validateSelection(selectionForMode(mode, custom), { unavailable });
}

/** The scenarios this deployment cannot run, for the picker to show disabled with their reason. */
export async function handleScenarios(deps: ScenariosRouteDeps): Promise<NextResponse> {
  const unavailable = [...(await deps.unavailable())].map(([id, reason]) => ({ id, reason }));
  return NextResponse.json({ unavailable }, { headers: { "cache-control": "no-store" } });
}

/**
 * The deposit memo an exchange session sends with its close: a uint64 from fresh randomness,
 * written as an id memo is (decimal, no leading zero), never zero.
 */
export function newExchangeMemo(random: (size: number) => Buffer = randomBytes): string {
  for (;;) {
    const value = BigInt(`0x${random(8).toString("hex")}`);
    if (value > BigInt(0)) return value.toString(10);
  }
}

/** The plan's demo funding, from its setup step. */
function setupFundingXlm(steps: readonly MessStepDef[]): string {
  for (const step of steps) if (step.action.kind === "setup") return step.action.fundingXlm;
  throw new Error("A plan with no setup step");
}

/** A rejection the network answered: the transaction never applied. */
function isDefinitiveRejection(err: unknown): boolean {
  return err instanceof TxSubmitError && err.resultCode !== null;
}

/** Deletes a session whose demo was never created; on failure the reaper finds the demo missing. */
async function discardSession(store: SessionStore, session: PlaygroundSession): Promise<void> {
  try {
    const lock = await store.acquireLock(session.id);
    if (!lock) throw new Error("session lock held");
    try {
      await store.deleteSession(lock);
    } finally {
      await store.releaseLock(lock);
    }
  } catch (err) {
    console.error(
      "[playground] unfunded session not deleted; the reaper will",
      { sessionId: session.id, demo: session.demoPublic },
      err instanceof Error ? err.name : "unknown"
    );
  }
}

async function refusedForFunds(store: SessionStore): Promise<NextResponse> {
  const failure = await store.lastFaucetFailure().catch(() => null);
  const error =
    failure === "rate_limited"
      ? "faucet_rate_limited"
      : failure === "unavailable"
        ? "faucet_unavailable"
        : "playground_refilling";
  return NextResponse.json({ error }, { status: 503 });
}

export async function handleCreateSession(
  req: NextRequest,
  deps: CreateSessionDeps
): Promise<NextResponse> {
  // Each session draws a funded testnet account from the market maker, spawns ephemeral issuers,
  // and writes a custodial session to KV. Anonymous and unbounded, that drains the market maker.
  const limited = await deps.rateLimit(req, "session", SESSIONS_PER_DAY_PER_IP);
  if (limited) return limited;

  const issuer = deps.issuer();
  const mm = deps.mm();
  if (!issuer || !mm || !isCronSecretConfigured(deps.cronSecret())) {
    return notConfiguredResponse();
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    // Malformed or absent body - use defaults.
    body = undefined;
  }
  const parsed = parseCreateBody(body, await deps.unavailable());
  if (!parsed.ok) {
    return NextResponse.json(
      { error: "invalid_selection", message: parsed.message },
      { status: 400 }
    );
  }
  const { plan } = parsed;

  let mmBalance: NativeBalance;
  try {
    mmBalance = await deps.marketMakerBalance(mm.publicKey());
  } catch (err) {
    console.error("[playground] market maker balance read failed", err);
    return NextResponse.json({ error: "provision_failed" }, { status: 502 });
  }
  if (spendableXlm(mmBalance) < MM_SESSION_FLOOR_XLM) return refusedForFunds(deps.store);

  // Keys are always fresh randomness, never derived from anything in the request.
  const demo = Keypair.random();
  const ephemeral = plan.ephemeralAssets.map((code) => ({
    assetCode: code,
    keypair: Keypair.random(),
  }));
  const recipient = plan.steps.some((s) => s.action.kind === "open_recipient")
    ? Keypair.random()
    : null;
  const helpers = plan.steps.flatMap((s) => {
    const role = helperRoleOf(s.action);
    return role ? [{ role, keypair: Keypair.random() }] : [];
  });
  // The stand-in comes from the bundled registry, and the memo from fresh randomness; nothing in
  // the request chooses either.
  const exchange: SessionExchange | null = closesToExchange(plan.selection)
    ? { destination: EXCHANGE_STAND_IN.address, memo: newExchangeMemo(), memoType: "id" }
    : null;

  // The record, with every key encrypted, is written before the demo account exists, so there is
  // never a funded account whose key is held nowhere.
  let session: PlaygroundSession;
  try {
    session = await deps.store.createSession({
      demoPublic: demo.publicKey(),
      encDemoSecret: deps.encrypt(demo.secret()),
      ephemeralIssuers: ephemeral.map((e) => ({
        publicKey: e.keypair.publicKey(),
        encSecret: deps.encrypt(e.keypair.secret()),
        assetCode: e.assetCode,
      })),
      completedMessSteps: [],
      recordedSigners: [],
      demolishLog: [],
      demolishPending: null,
      demolishDone: false,
      selection: plan.selection,
      transferRecipient: recipient && {
        publicKey: recipient.publicKey(),
        encSecret: deps.encrypt(recipient.secret()),
      },
      helperAccounts: helpers.map(({ role, keypair }) => ({
        role,
        publicKey: keypair.publicKey(),
        encSecret: deps.encrypt(keypair.secret()),
      })),
      claimableBalances: [],
      allowances: [],
      exchange,
    });
  } catch (err) {
    if (err instanceof PlaygroundConfigError || err instanceof PlaygroundStoreUnavailableError) {
      return notConfiguredResponse();
    }
    throw err;
  }

  try {
    await withAccountLock(
      deps.store,
      mm.publicKey(),
      async () => {
        // Under the market maker's lock, so two sessions never both create the stand-in.
        if (exchange) await deps.ensureExchangeAccount(mm, exchange.destination);
        await deps.provisionDemo(mm, demo.publicKey(), setupFundingXlm(plan.steps));
      },
      deps.accountLock
    );
  } catch (err) {
    const busy = err instanceof AccountBusyError;
    // An outcome the network did not answer may still land: the record stays for the reaper.
    if (busy || isDefinitiveRejection(err)) await discardSession(deps.store, session);
    console.error(
      "[playground] demo account not created",
      { sessionId: session.id, demo: session.demoPublic },
      err instanceof Error ? err.name : "unknown"
    );
    return busy
      ? NextResponse.json({ error: "playground_busy" }, { status: 503 })
      : NextResponse.json({ error: "provision_failed" }, { status: 502 });
  }

  return NextResponse.json({
    sessionId: session.id,
    demoPublic: session.demoPublic,
    expiresAt: sessionExpiresAt(),
    messPlan: plan.steps,
    accounts: {
      issuer: issuer.publicKey(),
      mm: mm.publicKey(),
      lwdemoAsset: `${LWDEMO_CODE}:${issuer.publicKey()}`,
      ephemeral: ephemeral.map((e) => ({ code: e.assetCode, publicKey: e.keypair.publicKey() })),
      transferRecipient: recipient?.publicKey() ?? null,
      helpers: helpers.map(({ role, keypair }) => ({ role, publicKey: keypair.publicKey() })),
      exchange,
    },
  });
}

export async function handleMess(
  req: NextRequest,
  id: string,
  deps: MessDeps
): Promise<NextResponse> {
  let stepId: unknown;
  try {
    const body: unknown = await req.json();
    if (body === null || typeof body !== "object") {
      throw new Error("invalid body");
    }
    stepId = "stepId" in body ? body.stepId : undefined;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (typeof stepId !== "string" || !isMessStepId(stepId)) {
    return NextResponse.json({ error: "invalid_step" }, { status: 400 });
  }

  const issuer = deps.issuer();
  const mm = deps.mm();
  if (!issuer || !mm) return notConfiguredResponse();

  const result = await runMessStep(deps.store, id, stepId, {
    executeStep: (step, session, recordSigner, recordClaimableBalances, recordAllowance) =>
      deps.executeMessStep(step, {
        demo: Keypair.fromSecret(deps.decrypt(session.encDemoSecret)),
        ephemeralIssuers: new Map(
          session.ephemeralIssuers.map((e) => [
            e.assetCode,
            Keypair.fromSecret(deps.decrypt(e.encSecret)),
          ])
        ),
        persistentIssuer: issuer,
        mmPublic: mm.publicKey(),
        transferRecipient:
          session.transferRecipient &&
          Keypair.fromSecret(deps.decrypt(session.transferRecipient.encSecret)),
        helpers: helperKeys(session, deps.decrypt),
        // Encrypted here, before it is stored: a co-signer's secret or a preimage is never written
        // in the clear.
        recordSigner: ({ type, key, weight, secret }) =>
          recordSigner({
            type,
            key,
            weight,
            encSecret: secret === null ? null : deps.encrypt(secret),
          }),
        recordClaimableBalances,
        allowances: session.allowances,
        recordAllowance,
      }),
  });
  return actionResponse(result);
}

/** The recorded signers the playground holds a secret for, decrypted for one round. */
function signingKeysOf(
  session: PlaygroundSession,
  decrypt: (payload: string) => string
): SigningKey[] {
  return session.recordedSigners.flatMap(({ type, key, encSecret }) =>
    encSecret === null ? [] : [signingKeyOf(type, key, decrypt(encSecret))]
  );
}

function helperKeys(
  session: PlaygroundSession,
  decrypt: (payload: string) => string
): Map<HelperRole, Keypair> {
  return new Map(
    session.helperAccounts.map((h) => [h.role, Keypair.fromSecret(decrypt(h.encSecret))])
  );
}

/** The beneficiary's sponsored trustline asset and data entry key, from the session's plan. */
function sponsoredEntriesOf(session: PlaygroundSession): { asset: Asset; dataKey: string } | null {
  for (const step of resolvePlan(session.selection).steps) {
    if (step.action.kind !== "sponsored_entries") continue;
    const code = step.action.asset;
    const issuer = session.ephemeralIssuers.find((e) => e.assetCode === code);
    if (!issuer) return null;
    return { asset: new Asset(code, issuer.publicKey), dataKey: step.action.dataEntry.key };
  }
  return null;
}

function resolutionContext(
  session: PlaygroundSession,
  decrypt: (payload: string) => string
): ResolutionContext {
  // The last recorded attempt is the transaction that landed: earlier attempts never did.
  const sponsoredByDemo = session.claimableBalances.filter((b) => b.intent === "demo_sponsored");
  return {
    helpers: helperKeys(session, decrypt),
    demoSponsoredBalanceId: sponsoredByDemo[sponsoredByDemo.length - 1]?.id ?? null,
    sponsored: sponsoredEntriesOf(session),
  };
}

/** Longest blocker code read from a resolve request; the API's codes are far shorter. */
const MAX_BLOCKER_LENGTH = 64;

/**
 * Resolves a blocker the close reported, when the session's plan expects it: the helper that owns
 * the entry claims the balance or releases its sponsored entries with its own key. The demo key
 * signs nothing here.
 */
export async function handleResolve(
  req: NextRequest,
  id: string,
  deps: ResolveRouteDeps
): Promise<NextResponse> {
  let blocker: unknown;
  try {
    const body: unknown = await req.json();
    blocker = isRecord(body) ? body.blocker : undefined;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (typeof blocker !== "string" || blocker.length === 0 || blocker.length > MAX_BLOCKER_LENGTH) {
    return NextResponse.json({ error: "resolution_unavailable" }, { status: 400 });
  }
  const result = await runResolve(deps.store, id, blocker, resolveActionDeps(deps));
  return actionResponse(result);
}

export function resolveActionDeps(deps: Omit<ResolveRouteDeps, "store">): ResolveDeps {
  return {
    resolve: (session, resolution) => {
      const { source, ops } = resolutionTransaction(
        resolution.kind,
        resolutionContext(session, deps.decrypt)
      );
      return deps.submit(source, ops);
    },
  };
}

/** The allowance list and revoke's dependencies, or null when the API setting is missing. */
export function revokeActionDeps(
  deps: Omit<AllowancesRouteDeps, "store">
): RevokeAllowanceDeps | null {
  const { apiUrl, apiKey } = deps.api();
  if (!apiUrl || !apiKey) return null;
  const api = deps.allowanceApi(apiUrl, apiKey);
  return {
    list: async (session) =>
      recordedListed((await api.getAllowances(session.demoPublic)).allowances, session.allowances),
    // The spender and every check's expectation come from the session as this request's lock
    // read it.
    revoke: (session, allowance) =>
      revokeRecordedAllowance({
        demo: Keypair.fromSecret(deps.decrypt(session.encDemoSecret)),
        signingKeys: signingKeysOf(session, deps.decrypt),
        recorded: session.allowances,
        allowance,
        api,
        signerState: deps.signerState,
      }),
  };
}

/**
 * The allowances the session recorded, each marked with whether the API's list for the demo shows
 * it, and with its spender's position in the record (from 1), which names its scene node. Read
 * only.
 */
export async function handleAllowances(
  id: string,
  deps: AllowancesRouteDeps
): Promise<NextResponse> {
  const session = await loadSessionOrErrorResponse(deps.store, id);
  if (session instanceof NextResponse) return session;
  const actions = revokeActionDeps(deps);
  if (!actions) return notConfiguredResponse();
  return actionResponse(await readSessionAllowances(session, actions));
}

/** A spender is a public key, 56 characters; anything longer is not read. */
const MAX_SPENDER_LENGTH = 56;

/**
 * Revokes one allowance the session recorded, named by its spender, before the close: the API
 * builds the revoke, both checks hold it to the session record, and the demo key signs it.
 */
export async function handleRevokeAllowance(
  req: NextRequest,
  id: string,
  deps: AllowancesRouteDeps
): Promise<NextResponse> {
  let spender: unknown;
  try {
    const body: unknown = await req.json();
    spender = isRecord(body) ? body.spender : undefined;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (typeof spender !== "string" || spender.length === 0 || spender.length > MAX_SPENDER_LENGTH) {
    return NextResponse.json({ error: "allowance_not_recorded" }, { status: 400 });
  }
  const actions = revokeActionDeps(deps);
  if (!actions) return notConfiguredResponse();
  return actionResponse(await runRevokeAllowance(deps.store, id, spender, actions));
}

/**
 * Runs one round of the close. The client calls again while `done` is false, and after a failure
 * (the resume); each call takes the session lock for its own round only.
 */
export async function handleDemolishRound(
  id: string,
  deps: DemolishRouteDeps
): Promise<NextResponse> {
  const roundDeps = demolishRoundDeps(deps);
  if (!roundDeps) return notConfiguredResponse();
  return actionResponse(await runDemolishRound(deps.store, id, roundDeps));
}

/** The close's dependencies, or null when a key or the API setting is missing. */
export function demolishRoundDeps(
  deps: Omit<DemolishRouteDeps, "store">
): DemolishRoundDeps | null {
  const mm = deps.mm();
  const issuer = deps.issuer();
  const { apiUrl, apiKey } = deps.api();
  if (!mm || !issuer || !apiUrl || !apiKey) return null;
  return {
    // The expectation is derived from the session as this round's lock read it.
    round: (session, hooks) =>
      deps.runDemolish({
        demoKeypair: Keypair.fromSecret(deps.decrypt(session.encDemoSecret)),
        signingKeys: signingKeysOf(session, deps.decrypt),
        expected: expectationFromSession(
          session,
          mm.publicKey(),
          issuer.publicKey(),
          deps.feeAccount()
        ),
        mediatorKey: deps.mediatorKey(),
        apiUrl,
        apiKey,
        hooks,
      }),
  };
}

/**
 * Recycles every account the session holds a key for into the market maker, then deletes the
 * session: the demo first when the close has not merged it, then the transfer recipient, the
 * helpers and the ephemeral issuers. An issuer is never merged while the demo may still hold its
 * asset, since the close returns that asset to it. An account already gone counts as recycled;
 * anything else that fails keeps the record for the next attempt.
 */
export async function handleCleanup(id: string, deps: CleanupRouteDeps): Promise<NextResponse> {
  const cleanup = cleanupActionDeps(deps);
  if (!cleanup) return notConfiguredResponse();
  return actionResponse(await runCleanup(deps.store, id, cleanup));
}

export function cleanupActionDeps(deps: Omit<CleanupRouteDeps, "store">): CleanupDeps | null {
  const mm = deps.mm();
  const issuer = deps.issuer();
  if (!mm || !issuer) return null;
  return { recycle: (session) => recycleSessionAccounts(session, mm.publicKey(), issuer, deps) };
}

async function recycleSessionAccounts(
  session: PlaygroundSession,
  mmPublic: string,
  issuer: Keypair,
  deps: Omit<CleanupRouteDeps, "store">
): Promise<RecycleResult> {
  const recycled: string[] = [];
  /** Runs `retire` unless the account is already gone; false when it failed. */
  const settle = async (publicKey: string, retire: () => Promise<unknown>): Promise<boolean> => {
    try {
      if (await deps.exists(publicKey)) await retire();
      recycled.push(publicKey);
      return true;
    } catch (err) {
      console.error(
        "[playground] cleanup could not recycle an account",
        { sessionId: session.id, account: publicKey },
        err instanceof Error ? err.name : "unknown"
      );
      return false;
    }
  };
  const result = (): RecycleResult => {
    const gone = new Set(recycled);
    return {
      recycled,
      complete: false,
      patch: {
        transferRecipient:
          session.transferRecipient && !gone.has(session.transferRecipient.publicKey)
            ? session.transferRecipient
            : null,
        helperAccounts: session.helperAccounts.filter((h) => !gone.has(h.publicKey)),
        ephemeralIssuers: session.ephemeralIssuers.filter((e) => !gone.has(e.publicKey)),
      },
    };
  };

  if (!session.demolishDone) {
    // A close transaction in flight is settled by the next round, never raced by a merge here.
    if (session.demolishPending !== null) return result();
    const demo = Keypair.fromSecret(deps.decrypt(session.encDemoSecret));
    if (!(await settle(session.demoPublic, () => deps.merge(demo, mmPublic)))) return result();
  }

  let complete = true;
  const recipient = session.transferRecipient;
  if (recipient) {
    const { steps, expectation } = resolvePlan(session.selection);
    const opened = steps.flatMap((s) =>
      s.action.kind === "open_recipient" ? s.action.assets : []
    );
    // Only a finished close has paid the recipient what the session recorded.
    const received = session.demolishDone
      ? expectation.dispositions.filter((d) => d.choice === "transfer")
      : [];
    const ok = await settle(recipient.publicKey, () =>
      deps.submit(
        Keypair.fromSecret(deps.decrypt(recipient.encSecret)),
        retireRecipientOps(issuer.publicKey(), mmPublic, opened, received)
      )
    );
    complete &&= ok;
  }
  for (const h of session.helperAccounts) {
    const ok = await settle(h.publicKey, async () => {
      const kp = Keypair.fromSecret(deps.decrypt(h.encSecret));
      const sponsored = h.role === "beneficiary" ? sponsoredEntriesOf(session) : null;
      // A beneficiary still holds its entries unless the resolution released them.
      const released = sponsored
        ? await deps
            .submit(kp, [
              Operation.changeTrust({ asset: sponsored.asset, limit: "0" }),
              Operation.manageData({ name: sponsored.dataKey, value: null }),
              Operation.accountMerge({ destination: mmPublic }),
            ])
            .then(() => true)
            .catch(() => false)
        : false;
      if (!released) await deps.merge(kp, mmPublic);
    });
    complete &&= ok;
  }
  for (const eph of session.ephemeralIssuers) {
    const ok = await settle(eph.publicKey, async () => {
      const kp = Keypair.fromSecret(deps.decrypt(eph.encSecret));
      // A forfeited balance names its issuer as a claimant; the issuer sponsors it, so it claims
      // it back before it can merge.
      const forfeited = session.claimableBalances.filter(
        (b) => b.intent === "forfeit" && b.asset.endsWith(`:${eph.publicKey}`)
      );
      if (forfeited.length > 0) {
        await deps
          .submit(
            kp,
            forfeited.map((b) => Operation.claimClaimableBalance({ balanceId: b.id }))
          )
          .catch(() => {
            console.error("[playground] cleanup claim-back failed", { issuer: eph.publicKey });
          });
      }
      await deps.merge(kp, mmPublic);
    });
    complete &&= ok;
  }
  return { ...result(), complete };
}

export async function handleCredentials(
  req: NextRequest,
  id: string,
  deps: CredentialsDeps
): Promise<NextResponse> {
  // This route decrypts and hands back a secret key; unbounded, it is a free oracle over every
  // session id an attacker can guess or scrape.
  const limited = await deps.rateLimit(req, "credentials", CREDENTIALS_PER_DAY_PER_IP);
  if (limited) return limited;

  const session = await loadSessionOrErrorResponse(deps.store, id);
  if (session instanceof NextResponse) return session;

  try {
    const secretKey = deps.decrypt(session.encDemoSecret);
    return NextResponse.json({ publicKey: session.demoPublic, secretKey });
  } catch (err) {
    if (err instanceof PlaygroundConfigError) {
      return notConfiguredResponse();
    }
    throw err;
  }
}

export async function handleState(id: string, deps: StateRouteDeps): Promise<NextResponse> {
  const session = await loadSessionOrErrorResponse(deps.store, id);
  if (session instanceof NextResponse) return session;

  const { apiUrl, apiKey } = deps.api();
  if (!apiUrl || !apiKey) return notConfiguredResponse();

  return actionResponse(
    await readSessionState(session, { getAccount: deps.accountReader(apiUrl, apiKey) })
  );
}

export interface ReapRouteDeps {
  cronSecret: () => string | undefined;
  /** Builds the reaper's dependencies, or null when a key or setting is missing. Called only
   *  once the request has shown the cron secret. */
  reaper: () => ReaperDeps | null;
}

/**
 * The scheduled reaper. The cron secret is checked before anything is read, decrypted or sent, and
 * the summary holds counts only.
 */
export async function handleReap(req: NextRequest, deps: ReapRouteDeps): Promise<NextResponse> {
  if (!isCronAuthorized(req.headers.get("authorization"), deps.cronSecret())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const reaper = deps.reaper();
  if (!reaper) return notConfiguredResponse();
  try {
    return NextResponse.json(await runReaper(reaper), {
      headers: { "cache-control": "no-store" },
    });
  } catch (err) {
    if (err instanceof PlaygroundStoreUnavailableError || err instanceof PlaygroundConfigError) {
      return notConfiguredResponse();
    }
    throw err;
  }
}
