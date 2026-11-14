import { randomBytes } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { NextRequest, NextResponse } from "next/server";
import { Keypair } from "@stellar/stellar-sdk";
import type { BatchPlanRequest, BatchPlanResponse, PlanResponse } from "@lumenwipe/sdk";
import {
  handleBatchPlan,
  handleBatchSdkSnippet,
  handleCreateBatch,
  type BatchPlanRouteDeps,
  type CreateBatchDeps,
  type DemoFunding,
} from "@/lib/batch-handlers";
import { TxSubmitError } from "@/lib/horizon-submit";
import { MM_SESSION_FLOOR_XLM } from "@/lib/market-maker";
import type { RateLimit } from "@/lib/rate-limit";
import {
  BLOCKED_MEMBER_SELECTION,
  DEFAULT_BATCH_MEMBERS,
  LIGHT_SELECTION,
  demoFundingXlm,
  resolvePlan,
  validateBatch,
  type ScenarioSelection,
} from "@/lib/scenarios";
import { buildBatchSdkSnippet, snippetInputFromExpectation } from "@/lib/sdk-snippet";
import type { PlaygroundSession, SessionStore } from "@/lib/session-store";
import { MM_KEEP_XLM } from "@/lib/standing-liquidity";
import { expectationFromSession } from "@/lib/verify";
import { memoryStore } from "./session-fixtures";

// The batch routes: a start creates two or three ordinary sessions, funded by one market maker
// transaction under its lock; the plan route asks the API about every member with one call and
// holds the answer to the batch's own addresses; the snippet route builds the batch's SDK code.
// Every key is generated per run, and the "encryption" is a reversible stand-in.

const ORIGIN = "http://localhost:3002";
const UNKNOWN_ID = "0b9d6a52-7c41-4e8f-a3b2-5c6d7e8f9a01";
const encrypt = (plaintext: string): string =>
  `enc:${Buffer.from(plaintext, "utf8").toString("base64")}`;
const CRON_SECRET = randomBytes(16).toString("hex");
const MM_FUNDED = { balance: "10000.0000000", sellingLiabilities: "3000.0000000" };

function request(path: string, init: { method?: string; body?: string } = {}): NextRequest {
  return new NextRequest(new URL(path, ORIGIN), {
    method: init.method ?? "POST",
    body: init.body,
    headers: { "content-type": "application/json", "x-real-ip": "203.0.113.7" },
  });
}

async function outcome(res: NextResponse): Promise<{ status: number; body: unknown }> {
  return { status: res.status, body: await res.json() };
}

const allow: RateLimit = async () => null;

/** A limiter that allows `allowed` calls, then refuses, recording each namespace it was asked. */
function countingLimit(allowed = Infinity): { limit: RateLimit; calls: string[] } {
  const calls: string[] = [];
  const limit: RateLimit = async (_req, namespace) => {
    calls.push(namespace);
    return calls.length > allowed
      ? NextResponse.json({ error: "rate_limited" }, { status: 429 })
      : null;
  };
  return { limit, calls };
}

const issuer = Keypair.random();
const mm = Keypair.random();

interface Provisioned {
  demos: DemoFunding[];
  /** Whether the market maker's lease was held while the transaction was sent. */
  underLock: boolean;
}

function createDeps(overrides: Partial<CreateBatchDeps> = {}) {
  const store = memoryStore();
  const provisioned: Provisioned[] = [];
  const encrypted: string[] = [];
  const deps: CreateBatchDeps = {
    store,
    rateLimit: allow,
    issuer: () => issuer,
    mm: () => mm,
    cronSecret: () => CRON_SECRET,
    marketMakerBalance: async () => MM_FUNDED,
    provisionDemos: async (source, demos) => {
      if (source.publicKey() !== mm.publicKey()) throw new Error("not the market maker");
      const probe = await store.acquireLease(`account:${mm.publicKey()}`, 1000);
      if (probe) await store.releaseLease(probe);
      provisioned.push({ demos: [...demos], underLock: probe === null });
    },
    accountLock: { pollMs: 1 },
    encrypt: (plaintext) => {
      encrypted.push(plaintext);
      return encrypt(plaintext);
    },
    unavailable: () => new Map(),
    ...overrides,
  };
  return { deps, store, provisioned, encrypted };
}

const create = (deps: CreateBatchDeps, body: unknown) =>
  handleCreateBatch(request("/api/batch", { body: JSON.stringify(body) }), deps);

interface CreatedBatch {
  batchId: string;
  blockedIndex: number;
  members: { sessionId: string; demoPublic: string; label: string }[];
}

async function created(deps: CreateBatchDeps, members: readonly ScenarioSelection[]) {
  const res = await create(deps, { members });
  expect(res.status).toBe(200);
  return (await res.json()) as CreatedBatch;
}

describe("POST /api/batch", () => {
  test("creates every member as a session, funded by one market maker transaction under its lock", async () => {
    const { deps, store, provisioned, encrypted } = createDeps();
    const body = await created(deps, DEFAULT_BATCH_MEMBERS[3]);
    const resolved = validateBatch(DEFAULT_BATCH_MEMBERS[3]);
    if (!resolved.ok) throw new Error(resolved.message);

    expect(body.members).toHaveLength(3);
    expect(body.blockedIndex).toBe(2);
    expect(provisioned).toHaveLength(1);
    expect(provisioned[0]!.underLock).toBe(true);
    expect(provisioned[0]!.demos).toEqual(
      body.members.map((m, i) => ({
        publicKey: m.demoPublic,
        startingBalance: demoFundingXlm(resolved.batch.members[i]!.cost),
      }))
    );

    const sessions: PlaygroundSession[] = [];
    for (const m of body.members) {
      const s = await store.loadSession(m.sessionId);
      if (!s) throw new Error("member not stored");
      sessions.push(s);
    }
    // The server adds the blocked member; the request chose only the others.
    expect(sessions.map((s) => s.selection)).toEqual(
      [...DEFAULT_BATCH_MEMBERS[3], BLOCKED_MEMBER_SELECTION].map((s) => resolvePlan(s).selection)
    );
    // Every member is an ordinary indexed session the reaper reaches.
    expect((await store.indexedSessionIds()).sort()).toEqual(
      body.members.map((m) => m.sessionId).sort()
    );
    const batch = await store.loadBatch(body.batchId);
    expect(batch?.memberIds).toEqual(body.members.map((m) => m.sessionId));

    const text = JSON.stringify(body);
    expect(encrypted.length).toBeGreaterThan(0);
    for (const secret of encrypted) expect(text).not.toContain(secret);
    expect(text).not.toContain("enc:");
  });

  test("a body naming the blocked member is refused: only the server adds it", async () => {
    const { deps, store } = createDeps();
    const res = await create(deps, { members: [LIGHT_SELECTION, BLOCKED_MEMBER_SELECTION] });
    expect(res.status).toBe(400);
    expect(await store.indexedSessionIds()).toEqual([]);
  });

  test("a batch of four is refused before anything is created", async () => {
    const { deps, store, provisioned } = createDeps();
    const res = await create(deps, {
      members: [LIGHT_SELECTION, LIGHT_SELECTION, LIGHT_SELECTION],
    });
    expect(await outcome(res)).toEqual({
      status: 400,
      body: { error: "invalid_selection", message: "A batch can close at most 3 accounts." },
    });
    expect(provisioned).toEqual([]);
    expect(await store.indexedSessionIds()).toEqual([]);
  });

  test("a body that is not a batch is refused", async () => {
    const { deps } = createDeps();
    for (const body of [null, { members: "two" }, { selection: LIGHT_SELECTION }]) {
      expect((await create(deps, body)).status).toBe(400);
    }
  });

  test("each member counts against the per-IP limit, and a refusal at the second creates nothing", async () => {
    const counted = countingLimit();
    const ok = createDeps({ rateLimit: counted.limit });
    await created(ok.deps, DEFAULT_BATCH_MEMBERS[3]);
    expect(counted.calls).toEqual(["session", "session", "session"]);

    const refusing = countingLimit(1);
    const { deps, store, provisioned } = createDeps({ rateLimit: refusing.limit });
    const res = await create(deps, { members: DEFAULT_BATCH_MEMBERS[2] });
    expect(await outcome(res)).toEqual({ status: 429, body: { error: "rate_limited" } });
    expect(provisioned).toEqual([]);
    expect(await store.indexedSessionIds()).toEqual([]);
  });

  test("the market maker must keep its floor after funding every member", async () => {
    const resolved = validateBatch(DEFAULT_BATCH_MEMBERS[3]);
    if (!resolved.ok) throw new Error(resolved.message);
    const draw = Number(resolved.batch.fundingXlm);
    const balance = (xlm: number) => ({
      balance: xlm.toFixed(7),
      sellingLiabilities: "0.0000000",
    });
    // Spendable is the balance less the keep: exactly the floor after the draw is enough.
    const atFloor = createDeps({
      marketMakerBalance: async () => balance(MM_SESSION_FLOOR_XLM + MM_KEEP_XLM + draw),
    });
    await created(atFloor.deps, DEFAULT_BATCH_MEMBERS[3]);

    // Enough for one member, short of the floor once all three are funded.
    const short = createDeps({
      marketMakerBalance: async () => balance(MM_SESSION_FLOOR_XLM + MM_KEEP_XLM + draw - 1),
    });
    const res = await create(short.deps, { members: DEFAULT_BATCH_MEMBERS[3] });
    expect(await outcome(res)).toEqual({ status: 503, body: { error: "playground_refilling" } });
    expect(short.provisioned).toEqual([]);
    expect(await short.store.indexedSessionIds()).toEqual([]);
  });

  test("a held market maker lock answers 503 and leaves nothing", async () => {
    const { deps, store, provisioned } = createDeps({ accountLock: { waitMs: 0, pollMs: 1 } });
    const held = await store.acquireLease(`account:${mm.publicKey()}`, 60_000);
    expect(held).not.toBeNull();
    const res = await create(deps, { members: DEFAULT_BATCH_MEMBERS[3] });
    expect(await outcome(res)).toEqual({ status: 503, body: { error: "playground_busy" } });
    expect(provisioned).toEqual([]);
    expect(await store.indexedSessionIds()).toEqual([]);
  });

  test("an outright rejection discards every member and writes no batch", async () => {
    const { deps, store } = createDeps({
      provisionDemos: async () => {
        throw new TxSubmitError("Transaction rejected: op_underfunded", "tx_failed");
      },
    });
    const res = await create(deps, { members: DEFAULT_BATCH_MEMBERS[3] });
    expect(await outcome(res)).toEqual({ status: 502, body: { error: "provision_failed" } });
    expect(await store.indexedSessionIds()).toEqual([]);
  });

  test("an unknown outcome keeps every member for the reaper", async () => {
    const { deps, store } = createDeps({
      provisionDemos: async () => {
        throw new TxSubmitError("The network is taking longer than usual to confirm.", null);
      },
    });
    const res = await create(deps, { members: DEFAULT_BATCH_MEMBERS[3] });
    expect(await outcome(res)).toEqual({ status: 502, body: { error: "provision_failed" } });
    const kept = await store.indexedSessionIds();
    expect(kept).toHaveLength(3);
    for (const id of kept) expect(await store.loadSession(id)).not.toBeNull();
  });

  test("not configured without the market maker, the issuer or the cron secret", async () => {
    for (const overrides of [
      { mm: () => null },
      { issuer: () => null },
      { cronSecret: () => undefined },
    ] satisfies Partial<CreateBatchDeps>[]) {
      const { deps, store } = createDeps(overrides);
      const res = await create(deps, { members: DEFAULT_BATCH_MEMBERS[2] });
      expect(res.status).toBe(503);
      expect(await store.indexedSessionIds()).toEqual([]);
    }
  });
});

// ─── GET /api/batch/[id]/plan ──────────────────────────────────────────────────

const sink = Keypair.random().publicKey();

function plan(status: PlanResponse["status"], blockers: PlanResponse["blockers"] = []) {
  return {
    planHash: "",
    status,
    steps: [],
    decisionPoints: [],
    blockers,
    estimate: { feeStroops: "0", freedReserveXlm: "0" },
    execution: { estimatedTransactionCount: 1, transactions: [] },
  } satisfies PlanResponse;
}

const BLOCKER = {
  code: "sponsorship_claimable_balance_unrevocable",
  message: "This account sponsors a claimable balance.",
};

/** A batch whose members have all run their mess. */
async function messedBatch(store: SessionStore = memoryStore()) {
  const { deps } = createDeps({ store });
  const body = await created(deps, DEFAULT_BATCH_MEMBERS[3]);
  for (const m of body.members) await finishMess(store, m.sessionId);
  return { store, body };
}

async function finishMess(store: SessionStore, id: string): Promise<void> {
  const lock = await store.acquireLock(id);
  if (!lock) throw new Error("lock held");
  try {
    await store.updateSession(lock, (s) => ({
      completedMessSteps: resolvePlan(s.selection).steps.map((step) => step.id),
    }));
  } finally {
    await store.releaseLock(lock);
  }
}

function planDeps(
  store: SessionStore,
  answer: (body: BatchPlanRequest) => BatchPlanResponse | Promise<BatchPlanResponse>,
  overrides: Partial<BatchPlanRouteDeps> = {}
) {
  const asked: BatchPlanRequest[] = [];
  const deps: BatchPlanRouteDeps = {
    store,
    rateLimit: allow,
    api: () => ({ apiUrl: "https://api.example", apiKey: "playground-key" }),
    sink: () => sink,
    batchPlan: () => async (body) => {
      asked.push(body);
      return answer(body);
    },
    ...overrides,
  };
  return { deps, asked };
}

const getPlan = (id: string, deps: BatchPlanRouteDeps) =>
  handleBatchPlan(request(`/api/batch/${id}/plan`, { method: "GET" }), id, deps);

/** The API's answer for `addresses`: the last one blocked, the others ready. */
const honest = ({ addresses }: BatchPlanRequest): BatchPlanResponse => ({
  results: addresses.map((address, i) => ({
    address,
    plan: i === addresses.length - 1 ? plan("blocked", [BLOCKER]) : plan("needs_decisions"),
  })),
});

describe("GET /api/batch/[id]/plan", () => {
  test("asks the API once for every member into the sink, and answers per member", async () => {
    const { store, body } = await messedBatch();
    const { deps, asked } = planDeps(store, honest);
    const res = await getPlan(body.batchId, deps);
    expect(res.status).toBe(200);
    expect(asked).toEqual([
      { addresses: body.members.map((m) => m.demoPublic), destination: sink },
    ]);
    const { results } = (await res.json()) as { results: unknown[] };
    expect(results).toEqual(
      body.members.map((m, i) => ({
        index: i,
        address: m.demoPublic,
        status: i === 2 ? "blocked" : "needs_decisions",
        blockers: i === 2 ? [BLOCKER] : [],
        estimatedTransactionCount: 1,
      }))
    );
  });

  test("results are matched by address, never by order", async () => {
    const { store, body } = await messedBatch();
    const reversed = (req: BatchPlanRequest) => ({
      results: [...honest(req).results].reverse(),
    });
    const res = await getPlan(body.batchId, planDeps(store, reversed).deps);
    const { results } = (await res.json()) as { results: { address: string; status: string }[] };
    expect(results.map((r) => r.address)).toEqual(body.members.map((m) => m.demoPublic));
    expect(results.map((r) => r.status)).toEqual(["needs_decisions", "needs_decisions", "blocked"]);
  });

  test("an answer naming a foreign address, one twice, or leaving one out is a mismatch", async () => {
    const { store, body } = await messedBatch();
    const foreign = Keypair.random().publicKey();
    const answers: ((req: BatchPlanRequest) => BatchPlanResponse)[] = [
      // Every member is there, plus one address that is none of them.
      (req) => ({
        results: [...honest(req).results, { address: foreign, plan: plan("ready") }],
      }),
      (req) => ({
        results: honest(req).results.map((r, i) => (i === 0 ? { ...r, address: foreign } : r)),
      }),
      (req) => {
        const { results } = honest(req);
        return { results: [results[0]!, results[0]!, results[2]!] };
      },
      (req) => ({ results: honest(req).results.slice(1) }),
      (req) => ({
        results: honest(req).results.map((r) => ({
          ...r,
          plan: { ...r.plan, status: "finished" as PlanResponse["status"] },
        })),
      }),
    ];
    for (const answer of answers) {
      expect(await outcome(await getPlan(body.batchId, planDeps(store, answer).deps))).toEqual({
        status: 502,
        body: { error: "batch_plan_mismatch" },
      });
    }
  });

  test("the answer carries no secret, no encrypted field and no member session id", async () => {
    const { store, body } = await messedBatch();
    const answer = (req: BatchPlanRequest) => ({
      results: honest(req).results.map((r) => ({
        ...r,
        plan: { ...r.plan, steps: [{ secret: Keypair.random().secret() }] },
      })),
    });
    const text = JSON.stringify(
      await (await getPlan(body.batchId, planDeps(store, answer).deps)).json()
    );
    expect(text).not.toMatch(/S[A-Z2-7]{55}/);
    expect(text).not.toContain("enc:");
    expect(text).not.toContain(body.batchId);
    for (const m of body.members) expect(text).not.toContain(m.sessionId);
  });

  test("is rate limited per caller before anything is read or asked", async () => {
    const { store, body } = await messedBatch();
    const counted = countingLimit(0);
    const { deps, asked } = planDeps(store, honest, { rateLimit: counted.limit });
    expect(await outcome(await getPlan(body.batchId, deps))).toEqual({
      status: 429,
      body: { error: "rate_limited" },
    });
    expect(counted.calls).toEqual(["batch-plan"]);
    expect(asked).toEqual([]);
  });

  test("an id that is not a batch is not found: a malformed one, an unknown one, a member's", async () => {
    const { store, body } = await messedBatch();
    const { deps, asked } = planDeps(store, honest);
    for (const id of ["../../etc/passwd", UNKNOWN_ID, body.members[0]!.sessionId]) {
      expect(await outcome(await getPlan(id, deps))).toEqual({
        status: 404,
        body: { error: "batch_not_found" },
      });
    }
    expect(asked).toEqual([]);
  });

  test("answers 409 until every member has run its mess", async () => {
    const store = memoryStore();
    const { deps: createBatchDeps } = createDeps({ store });
    const body = await created(createBatchDeps, DEFAULT_BATCH_MEMBERS[2]);
    await finishMess(store, body.members[0]!.sessionId);
    const { deps, asked } = planDeps(store, honest);
    expect(await outcome(await getPlan(body.batchId, deps))).toEqual({
      status: 409,
      body: { error: "batch_not_ready" },
    });
    expect(asked).toEqual([]);
  });

  test("a member whose record is gone makes the batch expired", async () => {
    const { store, body } = await messedBatch();
    const id = body.members[1]!.sessionId;
    const lock = await store.acquireLock(id);
    if (!lock) throw new Error("lock held");
    await store.deleteSession(lock);
    expect(await outcome(await getPlan(body.batchId, planDeps(store, honest).deps))).toEqual({
      status: 404,
      body: { error: "session_not_found" },
    });
  });

  test("an API failure is batch_plan_failed; no API or sink is not_configured", async () => {
    const { store, body } = await messedBatch();
    const failing = planDeps(store, () => {
      throw new Error("ECONNRESET");
    });
    expect(await outcome(await getPlan(body.batchId, failing.deps))).toEqual({
      status: 502,
      body: { error: "batch_plan_failed" },
    });
    for (const overrides of [
      { api: () => ({ apiUrl: undefined, apiKey: "k" }) },
      { sink: () => null },
    ] satisfies Partial<BatchPlanRouteDeps>[]) {
      const res = await getPlan(body.batchId, planDeps(store, honest, overrides).deps);
      expect(res.status).toBe(503);
    }
  });
});

// ─── GET /api/batch/[id]/sdk-snippet ───────────────────────────────────────────

describe("GET /api/batch/[id]/sdk-snippet", () => {
  test("serves the batch's code from each member's expectation, and is not configured without the accounts", async () => {
    const { store, body } = await messedBatch();
    const accounts = { sink, issuer: issuer.publicKey() };
    const res = await handleBatchSdkSnippet(body.batchId, {
      store,
      publicAccounts: () => accounts,
    });
    expect(res.status).toBe(200);
    const members: PlaygroundSession[] = [];
    for (const m of body.members) members.push((await store.loadSession(m.sessionId))!);
    const { snippet } = (await res.json()) as { snippet: string };
    expect(snippet).toBe(
      buildBatchSdkSnippet({
        network: "testnet",
        closes: members.map(
          (s) =>
            snippetInputFromExpectation(expectationFromSession(s, sink, accounts.issuer, null))
              .close
        ),
      })
    );
    for (const m of body.members) expect(snippet).not.toContain(m.sessionId);

    const unconfigured = await handleBatchSdkSnippet(body.batchId, {
      store,
      publicAccounts: () => null,
    });
    expect(unconfigured.status).toBe(503);
    const missing = await handleBatchSdkSnippet(UNKNOWN_ID, {
      store,
      publicAccounts: () => accounts,
    });
    expect(missing.status).toBe(404);
  });
});
