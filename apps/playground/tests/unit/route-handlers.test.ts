import { randomBytes } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { NextRequest, NextResponse } from "next/server";
import { Keypair, Operation, type xdr } from "@stellar/stellar-sdk";
import { LumenWipeApiError, type AccountState } from "@lumenwipe/sdk";
import { PlaygroundConfigError } from "@/lib/crypto";
import {
  DEFAULT_CUSTOM_CONFIG,
  getMessPlanForMode,
  selectionForMode,
  type PlaygroundCustomConfig,
  type PlaygroundMode,
} from "@/lib/mess-plan";
import {
  MAX_SCENARIOS,
  demoFundingXlm,
  formatReplayCode,
  generateRandomSelection,
  resolvePlan,
  type MessStepDef,
  type ScenarioSelection,
} from "@/lib/scenarios";
import { errorCopy } from "@/lib/error-copy";
import { TxSubmitError } from "@/lib/horizon-submit";
import type { MessContext } from "@/lib/mess-builders";
import { DemolishDecisionUnanswerableError, type RunDemolishOptions } from "@/lib/demolish";
import type { RateLimit } from "@/lib/rate-limit";
import {
  handleCleanup,
  handleCreateSession,
  handleCredentials,
  handleDemolishRound,
  handleMess,
  handleResolve,
  handleAllowances,
  handleRevokeAllowance,
  handleScenarios,
  handleState,
  parseCreateBody,
  type CleanupRouteDeps,
  type CreateSessionDeps,
} from "@/lib/route-handlers";
import {
  PlaygroundStoreUnavailableError,
  SESSION_RECORD_TTL_SECONDS,
  isSessionId,
  type NewSessionData,
  type SessionStore,
} from "@/lib/session-store";
import { fakeClock, memoryStore, newSessionData, type FakeClock } from "./session-fixtures";
import { revokeTx } from "./revoke-fixtures";
import type { AllowanceApi } from "@/lib/allowances";
import { XLM_SAC } from "@/lib/scenarios";
import { Networks, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";

// Every key here is generated per run by Keypair.random(); nothing checksum-valid is committed.
// The "encryption" is a reversible stand-in, so a test can tell which plaintexts a handler
// encrypted and assert none of them reaches a response.

const ORIGIN = "http://localhost:3002";
const UNKNOWN_ID = "0b9d6a52-7c41-4e8f-a3b2-5c6d7e8f9a01";
const NOT_A_UUID = "../../etc/passwd";

const ENC_PREFIX = "enc:";
const encrypt = (plaintext: string): string =>
  ENC_PREFIX + Buffer.from(plaintext, "utf8").toString("base64");
const decrypt = (payload: string): string => {
  if (!payload.startsWith(ENC_PREFIX)) throw new Error("not a test payload");
  return Buffer.from(payload.slice(ENC_PREFIX.length), "base64").toString("utf8");
};

function request(path: string, init: { method?: string; body?: string } = {}): NextRequest {
  return new NextRequest(new URL(path, ORIGIN), {
    method: init.method ?? "POST",
    body: init.body,
    headers: { "content-type": "application/json", "x-real-ip": "203.0.113.7" },
  });
}

const jsonBody = async (res: NextResponse): Promise<Record<string, unknown>> =>
  (await res.json()) as Record<string, unknown>;

const allow: RateLimit = async () => null;
const deny: RateLimit = async () => NextResponse.json({ error: "rate_limited" }, { status: 429 });

interface Seeded {
  id: string;
  demo: Keypair;
  issuers: Map<string, Keypair>;
}

async function seed(store: SessionStore, overrides: Partial<NewSessionData> = {}): Promise<Seeded> {
  const demo = Keypair.random();
  const issuers = new Map([
    ["AIRDROP1", Keypair.random()],
    ["RUGPULL", Keypair.random()],
  ]);
  const session = await store.createSession({
    ...newSessionData(),
    demoPublic: demo.publicKey(),
    encDemoSecret: encrypt(demo.secret()),
    ephemeralIssuers: [...issuers].map(([assetCode, kp]) => ({
      assetCode,
      publicKey: kp.publicKey(),
      encSecret: encrypt(kp.secret()),
    })),
    selection: selectionForMode("standard"),
    ...overrides,
  });
  return { id: session.id, demo, issuers };
}

/** A store whose every call is counted, to prove a request was refused before touching it. */
function countingStore(store: SessionStore): { store: SessionStore; calls: () => number } {
  let calls = 0;
  const wrap =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> => {
      calls++;
      return fn(...args);
    };
  return {
    store: {
      createSession: wrap(store.createSession),
      loadSession: wrap(store.loadSession),
      acquireLock: wrap(store.acquireLock),
      releaseLock: wrap(store.releaseLock),
      updateSession: wrap(store.updateSession),
      deleteSession: wrap(store.deleteSession),
      indexedSessionIds: wrap(store.indexedSessionIds),
      unindexSession: wrap(store.unindexSession),
      acquireLease: wrap(store.acquireLease),
      releaseLease: wrap(store.releaseLease),
      lastFaucetFailure: wrap(store.lastFaucetFailure),
      recordFaucetFailure: wrap(store.recordFaucetFailure),
      createBatch: wrap(store.createBatch),
      loadBatch: wrap(store.loadBatch),
    },
    calls: () => calls,
  };
}

const expired = (clock: FakeClock): void => clock.advance(SESSION_RECORD_TTL_SECONDS * 1000 + 1);

const NOT_CONFIGURED = { status: 503, body: { error: "not_configured" } };
// Generated per run: a cron secret the route accepts (32 hex characters).
const CRON_SECRET = randomBytes(16).toString("hex");
const MM_FUNDED = { balance: "10000.0000000", sellingLiabilities: "3000.0000000" };
const NOT_FOUND = { status: 404, body: { error: "session_not_found" } };

async function outcome(res: NextResponse): Promise<{ status: number; body: unknown }> {
  return { status: res.status, body: await res.json() };
}

// ─── POST /api/session ─────────────────────────────────────────────────────────

describe("create session", () => {
  const issuer = Keypair.random();
  const mm = Keypair.random();

  function createDeps(overrides: Partial<CreateSessionDeps> = {}) {
    const encrypted: string[] = [];
    const funded: string[] = [];
    const startingBalances: string[] = [];
    const store = memoryStore();
    const deps: CreateSessionDeps = {
      unavailable: () => new Map(),
      store,
      rateLimit: allow,
      issuer: () => issuer,
      mm: () => mm,
      cronSecret: () => CRON_SECRET,
      marketMakerBalance: async () => MM_FUNDED,
      ensureExchangeAccount: async () => "exists",
      provisionDemo: async (source, demoPublic, startingBalance) => {
        if (source.publicKey() !== mm.publicKey()) throw new Error("not the market maker");
        funded.push(demoPublic);
        startingBalances.push(startingBalance);
      },
      accountLock: { pollMs: 1 },
      encrypt: (plaintext) => {
        encrypted.push(plaintext);
        return encrypt(plaintext);
      },
      ...overrides,
    };
    return { deps, store, encrypted, funded, startingBalances };
  }

  const create = (deps: CreateSessionDeps, body?: unknown) =>
    handleCreateSession(
      request("/api/session", { body: body === undefined ? undefined : JSON.stringify(body) }),
      deps
    );

  test("each helper the plan needs is created with an encrypted key, never returned", async () => {
    const { deps, store, encrypted } = createDeps();
    const res = await create(deps, {
      selection: {
        scenarios: [
          { id: "claimable-balances", params: { demo_sponsored: 1 } },
          { id: "sponsored-reserves", params: { variant: 0 } },
        ],
      },
    });
    const body = await jsonBody(res);
    const stored = await store.loadSession(body.sessionId as string);
    expect(stored?.helperAccounts.map((h) => h.role)).toEqual(["claimant", "sponsor"]);
    expect(stored?.claimableBalances).toEqual([]);
    for (const h of stored?.helperAccounts ?? []) {
      const secret = encrypted.find((p) => Keypair.fromSecret(p).publicKey() === h.publicKey);
      if (!secret) throw new Error("helper secret was not encrypted");
      expect(h.encSecret).toBe(encrypt(secret));
      expect(JSON.stringify(body)).not.toContain(secret);
    }
    expect((body.accounts as { helpers: unknown }).helpers).toEqual(
      stored?.helperAccounts.map(({ role, publicKey }) => ({ role, publicKey }))
    );
  });

  test("a selection that transfers stores an encrypted recipient; any other stores none", async () => {
    const transferring = createDeps();
    const res = await create(transferring.deps, {
      selection: { scenarios: [{ id: "dispositions", params: { lwcoin: 2, lwgem: 1 } }] },
    });
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    const stored = await transferring.store.loadSession(body.sessionId as string);
    const recipient = stored?.transferRecipient;
    if (!recipient) throw new Error("expected a recipient");
    // The demo secret, then the recipient's; neither reaches the response.
    expect(transferring.encrypted).toHaveLength(2);
    const recipientSecret = transferring.encrypted[1]!;
    expect(Keypair.fromSecret(recipientSecret).publicKey()).toBe(recipient.publicKey);
    expect(recipient.encSecret).toBe(encrypt(recipientSecret));
    expect(JSON.stringify(body)).not.toContain(recipientSecret);
    expect((body.messPlan as MessStepDef[]).map((s) => s.id)).toContain("OPEN_RECIPIENT");

    const burning = createDeps();
    const other = await jsonBody(
      await create(burning.deps, {
        selection: { scenarios: [{ id: "dispositions", params: { lwcoin: 1, lwgem: 0 } }] },
      })
    );
    expect(
      (await burning.store.loadSession(other.sessionId as string))?.transferRecipient
    ).toBeNull();
    expect(burning.encrypted).toHaveLength(1);
  });

  test("a new session is stored and the response carries the plan and no secret", async () => {
    const { deps, store, encrypted, funded } = createDeps();
    const res = await create(deps, { mode: "standard" });
    expect(res.status).toBe(200);
    const body = await jsonBody(res);

    expect(isSessionId(body.sessionId as string)).toBe(true);
    expect(funded).toEqual([body.demoPublic as string]);
    expect(body.messPlan).toEqual(getMessPlanForMode("standard"));
    const accounts = body.accounts as Record<string, unknown>;
    expect(accounts.issuer).toBe(issuer.publicKey());
    expect(accounts.mm).toBe(mm.publicKey());
    expect(accounts.lwdemoAsset).toBe(`LWDEMO:${issuer.publicKey()}`);
    expect((accounts.ephemeral as { code: string }[]).map((e) => e.code)).toEqual([
      "AIRDROP1",
      "RUGPULL",
    ]);

    // The demo secret and both issuer secrets were encrypted, and none of them is in the response.
    expect(encrypted).toHaveLength(3);
    const text = JSON.stringify(body);
    for (const secret of encrypted) expect(text).not.toContain(secret);
    expect(text).not.toContain(ENC_PREFIX);

    const stored = await store.loadSession(body.sessionId as string);
    expect(stored).toMatchObject({
      demoPublic: body.demoPublic,
      completedMessSteps: [],
      recordedSigners: [],
      demolishLog: [],
      demolishPending: null,
      demolishDone: false,
      selection: resolvePlan(selectionForMode("standard")).selection,
      extended: false,
    });
    expect(decrypt(stored!.encDemoSecret)).toBe(encrypted[0]!);
    // The countdown the response shows is the one stored, an hour from the start.
    expect(body.expiresAt).toBe(stored!.expiresAt);
    expect(stored!.expiresAt - stored!.createdAt).toBeGreaterThanOrEqual(3600 * 1000);
    expect(stored!.expiresAt - stored!.createdAt).toBeLessThan(3600 * 1000 + 1000);
  });

  test("an over-limit caller gets 429 before any account is funded or stored", async () => {
    const limits: [string, number][] = [];
    const { deps, store, funded } = createDeps({
      rateLimit: async (req, namespace, limitPerDay) => {
        limits.push([namespace, limitPerDay]);
        return deny(req, namespace, limitPerDay);
      },
    });
    const counted = countingStore(store);
    const res = await create({ ...deps, store: counted.store }, { mode: "light" });
    expect(await outcome(res)).toEqual({ status: 429, body: { error: "rate_limited" } });
    expect(limits).toEqual([["session", 25]]);
    expect(funded).toEqual([]);
    expect(counted.calls()).toBe(0);
  });

  test("a missing issuer, market maker key or cron secret is not_configured, before any funding", async () => {
    for (const missing of [
      { issuer: () => null },
      { mm: () => null },
      { cronSecret: () => undefined },
      { cronSecret: () => "short" },
    ]) {
      const { deps, funded } = createDeps(missing);
      expect(await outcome(await create(deps, { mode: "light" }))).toEqual(NOT_CONFIGURED);
      expect(funded).toEqual([]);
    }
  });

  test("the demo is funded by the market maker with the plan's setup funding", async () => {
    const { deps, startingBalances } = createDeps();
    const res = await create(deps, { mode: "light" });
    const body = await jsonBody(res);
    const setup = (body.messPlan as MessStepDef[])[0]!.action;
    if (setup.kind !== "setup") throw new Error("expected the setup step first");
    expect(startingBalances).toEqual([setup.fundingXlm]);
    expect(setup.fundingXlm).toBe(demoFundingXlm(resolvePlan(selectionForMode("light")).cost));
  });

  test("creating a session calls no faucet and refreshes no offers: one balance read, one funding", async () => {
    const fetched: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL): Promise<Response> => {
        fetched.push(String(input));
        throw new Error("no network in this test");
      },
      { preconnect: () => {} }
    ) as typeof fetch;
    const reads: string[] = [];
    try {
      const { deps, funded } = createDeps({
        marketMakerBalance: async (publicKey) => {
          reads.push(publicKey);
          return MM_FUNDED;
        },
      });
      const res = await create(deps, { mode: "standard" });
      expect(res.status).toBe(200);
      expect(funded).toEqual([(await jsonBody(res)).demoPublic as string]);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(fetched).toEqual([]);
    expect(reads).toEqual([mm.publicKey()]);
  });

  test("below the floor a session is refused as temporarily unavailable, before anything is stored", async () => {
    // 10,000 XLM, but its offers have committed all but 520 and it keeps 50 for itself.
    const low = { balance: "10000.0000000", sellingLiabilities: "9480.0000000" };
    const { deps, store, funded } = createDeps({ marketMakerBalance: async () => low });
    const counted = countingStore(store);
    const res = await create({ ...deps, store: counted.store }, { mode: "light" });
    expect(await outcome(res)).toEqual({ status: 503, body: { error: "playground_refilling" } });
    expect(errorCopy("playground_refilling")).toContain("temporarily unavailable");
    expect(funded).toEqual([]);
    expect(await store.indexedSessionIds()).toEqual([]);

    const atFloor = { balance: "10000.0000000", sellingLiabilities: "9450.0000000" };
    const ok = createDeps({ marketMakerBalance: async () => atFloor });
    expect((await create(ok.deps, { mode: "light" })).status).toBe(200);
  });

  test("below the floor, the reaper's last faucet failure picks the copy", async () => {
    const low = { balance: "100.0000000", sellingLiabilities: "0" };
    for (const [failure, error] of [
      ["rate_limited", "faucet_rate_limited"],
      ["unavailable", "faucet_unavailable"],
    ] as const) {
      const { deps, store } = createDeps({ marketMakerBalance: async () => low });
      await store.recordFaucetFailure(failure);
      expect(await outcome(await create(deps, { mode: "light" }))).toEqual({
        status: 503,
        body: { error },
      });
    }
  });

  test("an unreadable market maker balance is provision_failed and stores nothing", async () => {
    const { deps, store } = createDeps({
      marketMakerBalance: async () => {
        throw new Error("horizon unavailable");
      },
    });
    expect(await outcome(await create(deps, { mode: "light" }))).toEqual({
      status: 502,
      body: { error: "provision_failed" },
    });
    expect(await store.indexedSessionIds()).toEqual([]);
  });

  test("the record and its index entry exist before the funding is submitted", async () => {
    let seen: string[] = [];
    const { deps, store } = createDeps();
    deps.provisionDemo = async () => {
      seen = await store.indexedSessionIds();
      expect(await store.loadSession(seen[0]!)).not.toBeNull();
    };
    const body = await jsonBody(await create(deps, { mode: "light" }));
    expect(seen).toEqual([body.sessionId as string]);
  });

  test("a funding the network rejected leaves no record and no index entry", async () => {
    const { deps, store } = createDeps({
      ensureExchangeAccount: async () => "exists",
      provisionDemo: async () => {
        throw new TxSubmitError(
          "Transaction rejected: tx_insufficient_balance",
          "tx_insufficient_balance"
        );
      },
    });
    const res = await create(deps, { mode: "light" });
    expect(await outcome(res)).toEqual({ status: 502, body: { error: "provision_failed" } });
    expect(await store.indexedSessionIds()).toEqual([]);
  });

  test("a funding whose outcome is unknown keeps the record for the reaper", async () => {
    const { deps, store } = createDeps({
      ensureExchangeAccount: async () => "exists",
      provisionDemo: async () => {
        throw new TxSubmitError("The network is taking longer than usual to confirm.", null);
      },
    });
    const res = await create(deps, { mode: "light" });
    expect(await outcome(res)).toEqual({ status: 502, body: { error: "provision_failed" } });
    const [id] = await store.indexedSessionIds();
    expect(await store.loadSession(id!)).not.toBeNull();
  });

  test("concurrent starts submit from the market maker one at a time", async () => {
    const { deps, store } = createDeps();
    let inFlight = 0;
    let most = 0;
    deps.provisionDemo = async () => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    };
    const results = await Promise.all(
      Array.from({ length: 4 }, () => create(deps, { mode: "light" }))
    );
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(most).toBe(1);
    expect(await store.indexedSessionIds()).toHaveLength(4);
  });

  test("a start that cannot get the market maker in time is playground_busy and stores nothing", async () => {
    const { deps, store } = createDeps({ accountLock: { waitMs: 0, pollMs: 1 } });
    const held = await store.acquireLease(`account:${mm.publicKey()}`, 60_000);
    expect(held).not.toBeNull();
    expect(await outcome(await create(deps, { mode: "light" }))).toEqual({
      status: 503,
      body: { error: "playground_busy" },
    });
    expect(await store.indexedSessionIds()).toEqual([]);
  });

  test("a missing encryption key or session store is not_configured", async () => {
    const noKey = createDeps({
      encrypt: () => {
        throw new PlaygroundConfigError("PLAYGROUND_ENCRYPTION_KEY is not set");
      },
    });
    expect(await outcome(await create(noKey.deps))).toEqual(NOT_CONFIGURED);

    const noStore = createDeps();
    noStore.deps.store = {
      ...noStore.store,
      createSession: async () => {
        throw new PlaygroundStoreUnavailableError();
      },
    };
    expect(await outcome(await create(noStore.deps))).toEqual(NOT_CONFIGURED);
  });

  test("any other store failure is not swallowed into a success", async () => {
    const { deps, store } = createDeps();
    deps.store = {
      ...store,
      createSession: async () => {
        throw new Error("ECONNRESET");
      },
    };
    await expect(create(deps)).rejects.toThrow("ECONNRESET");
  });

  test("a malformed or absent body falls back to the standard mode", async () => {
    for (const raw of [undefined, "not json", "null", "[]", '"light"']) {
      const { deps, store } = createDeps();
      const res = await handleCreateSession(request("/api/session", { body: raw }), deps);
      expect(res.status).toBe(200);
      const body = await jsonBody(res);
      expect(body.messPlan).toEqual(getMessPlanForMode("standard"));
      expect((await store.loadSession(body.sessionId as string))?.selection).toEqual(
        resolvePlan(selectionForMode("standard")).selection
      );
    }
  });

  test("a custom config is clamped to what the plan can build", async () => {
    const { deps, store } = createDeps();
    const res = await create(deps, {
      mode: "custom",
      customConfig: { trustlineCount: 99, offerCount: 99, dataEntryCount: -4, addSigner: "yes" },
    });
    const body = await jsonBody(res);
    const clamped = { trustlineCount: 5, offerCount: 5, dataEntryCount: 0, addSigner: false };
    expect(body.messPlan).toEqual(getMessPlanForMode("custom", clamped));
    expect((await store.loadSession(body.sessionId as string))?.selection).toEqual(
      resolvePlan(selectionForMode("custom", clamped)).selection
    );
  });

  test("a scenario selection is stored as validated and its plan returned", async () => {
    const { deps, store, encrypted } = createDeps();
    const selection: ScenarioSelection = {
      scenarios: [
        { id: "stablecoin-swaps", params: { tokens: 1 } },
        { id: "stale-offers", params: { count: 1 } },
      ],
    };
    const body = await jsonBody(await create(deps, { selection }));
    const plan = resolvePlan(selection);
    expect(body.messPlan).toEqual(plan.steps);
    expect((await store.loadSession(body.sessionId as string))?.selection).toEqual(plan.selection);
    // The demo key and the one USDC issuer key the plan needs, nothing more.
    expect(encrypted).toHaveLength(2);
    const accounts = body.accounts as { ephemeral: { code: string }[] };
    expect(accounts.ephemeral.map((e) => e.code)).toEqual(["USDC"]);
  });

  test("a selection the validator refuses is invalid_selection, before any funding or the store", async () => {
    const tooMany = {
      scenarios: Array.from({ length: MAX_SCENARIOS + 1 }, () => ({
        id: "data-entries",
        params: { count: 1 },
      })),
    };
    const cases: [unknown, string][] = [
      [{ scenarios: [] }, "Pick at least one scenario."],
      [tooMany, `A demo can include at most ${MAX_SCENARIOS} scenarios.`],
      [
        { scenarios: [{ id: "drop-table", params: {} }] },
        "The scenario selection could not be read.",
      ],
      ["standard", "The scenario selection could not be read."],
      [
        { scenarios: [{ id: "stale-offers", params: { count: 1 } }] },
        "Stale DEX offers needs one of these as well: Demo token holding, Junk airdrops, Stablecoin swaps.",
      ],
    ];
    for (const [selection, message] of cases) {
      const { deps, store, funded } = createDeps();
      const counted = countingStore(store);
      const res = await create({ ...deps, store: counted.store }, { selection });
      expect(await outcome(res)).toEqual({
        status: 400,
        body: { error: "invalid_selection", message },
      });
      expect(funded).toEqual([]);
      expect(counted.calls()).toBe(0);
    }
  });
});

describe("scenario availability", () => {
  test("a scenario switched off here is refused at create, with its reason, before any funding", async () => {
    const issuer = Keypair.random();
    const funded: string[] = [];
    const store = memoryStore();
    const counted = countingStore(store);
    const res = await handleCreateSession(
      request("/api/session", { body: JSON.stringify({ mode: "standard" }) }),
      {
        store: counted.store,
        rateLimit: allow,
        issuer: () => issuer,
        mm: () => issuer,
        cronSecret: () => CRON_SECRET,
        marketMakerBalance: async () => MM_FUNDED,
        ensureExchangeAccount: async () => "exists",
        provisionDemo: async (_mm, key) => {
          funded.push(key);
        },
        encrypt,
        unavailable: () =>
          new Map([["forgotten-signer", "Switched off on this deployment for now."]]),
      }
    );
    expect(await outcome(res)).toEqual({
      status: 400,
      body: {
        error: "invalid_selection",
        message:
          "Forgotten co-signer is not available here: Switched off on this deployment for now.",
      },
    });
    expect(funded).toEqual([]);
    expect(counted.calls()).toBe(0);
  });

  test("GET /api/scenarios lists the unavailable scenarios with their reasons, uncached", async () => {
    const res = await handleScenarios({
      unavailable: () => new Map([["stale-offers", "Switched off on this deployment for now."]]),
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      unavailable: [{ id: "stale-offers", reason: "Switched off on this deployment for now." }],
    });
  });
});

describe("parseCreateBody", () => {
  const selectionOf = (body: unknown): ScenarioSelection => {
    const parsed = parseCreateBody(body);
    if (!parsed.ok) throw new Error(parsed.message);
    return parsed.plan.selection;
  };
  const mode = (m: PlaygroundMode, custom?: PlaygroundCustomConfig): ScenarioSelection =>
    resolvePlan(selectionForMode(m, custom)).selection;

  test("only the four known modes are accepted", () => {
    expect(selectionOf({ mode: "light" })).toEqual(mode("light"));
    expect(selectionOf({ mode: "full" })).toEqual(mode("full"));
    expect(selectionOf({ mode: "LIGHT" })).toEqual(mode("standard"));
    expect(selectionOf({ mode: 1 })).toEqual(mode("standard"));
    expect(selectionOf(null)).toEqual(mode("standard"));
  });

  test("a custom config is read only in custom mode", () => {
    const custom = { trustlineCount: 4, offerCount: 3, dataEntryCount: 1, addSigner: true };
    expect(selectionOf({ mode: "light", customConfig: custom })).toEqual(mode("light"));
    expect(selectionOf({ mode: "custom", customConfig: custom })).toEqual(mode("custom", custom));
    expect(selectionOf({ mode: "custom" })).toEqual(mode("custom", DEFAULT_CUSTOM_CONFIG));
  });

  test("missing custom fields take defaults, and the offer default respects the trustlines", () => {
    const one = { trustlineCount: 1, offerCount: 1, dataEntryCount: 2, addSigner: false };
    expect(selectionOf({ mode: "custom", customConfig: { trustlineCount: 1 } })).toEqual(
      mode("custom", one)
    );
    expect(
      selectionOf({ mode: "custom", customConfig: { trustlineCount: 0, offerCount: 3 } })
    ).toEqual(mode("custom", one));
  });

  test("a replay code is regenerated on the server, and wins over a selection sent with it", () => {
    const code = formatReplayCode(123_456_789);
    const expected = generateRandomSelection(123_456_789)!;
    expect(selectionOf({ seed: code, selection: { scenarios: [{ id: "data-entries" }] } })).toEqual(
      expected
    );
    expect(selectionOf({ seed: code.toLowerCase() })).toEqual(expected);
  });

  test("a replay code is regenerated with this deployment's availability", () => {
    const unavailable = new Map([["forgotten-signer" as const, "off"]]);
    for (let seed = 0; seed < 200; seed++) {
      const parsed = parseCreateBody({ seed: formatReplayCode(seed) }, unavailable);
      if (!parsed.ok) throw new Error(parsed.message);
      expect(parsed.plan.selection.scenarios.map((c) => c.id)).not.toContain("forgotten-signer");
    }
  });

  test("a code that is not one is refused in plain language", () => {
    for (const seed of ["LW9-00000000", "LW1-0000000U", "", 42, null, ["LW1-00000000"]]) {
      expect(parseCreateBody({ seed })).toEqual({
        ok: false,
        message: "The replay code could not be read.",
      });
    }
  });

  test("a selection wins over a mode, and is validated rather than clamped", () => {
    expect(
      selectionOf({ mode: "full", selection: { scenarios: [{ id: "forgotten-signer" }] } })
    ).toEqual({ scenarios: [{ id: "forgotten-signer", params: {} }] });
    expect(
      parseCreateBody({ selection: { scenarios: [{ id: "data-entries", params: { count: 6 } }] } })
    ).toEqual({
      ok: false,
      message: "Leftover data entries: entries must be a whole number from 1 to 5.",
    });
  });
});

// ─── POST /api/session/[id]/mess ───────────────────────────────────────────────

describe("mess step", () => {
  const issuer = Keypair.random();
  const mm = Keypair.random();

  function messDeps(store: SessionStore, executed: [MessStepDef, MessContext][] = []) {
    return {
      store,
      issuer: () => issuer,
      mm: () => mm,
      encrypt,
      decrypt,
      executeMessStep: async (planned: MessStepDef, ctx: MessContext) => {
        executed.push([planned, ctx]);
        return "a".repeat(64);
      },
    };
  }
  const step = (id: string, body: unknown, deps: Parameters<typeof handleMess>[2]) =>
    handleMess(
      request(`/api/session/${id}/mess`, {
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
      id,
      deps
    );

  test("a step runs as the session's plan defines it, with the session's keys, and is recorded", async () => {
    const store = memoryStore();
    const selection: ScenarioSelection = {
      scenarios: [
        { id: "junk-airdrops", params: { tokens: 2 } },
        { id: "data-entries", params: { count: 1 } },
        { id: "stale-offers", params: { count: 2 } },
      ],
    };
    const plan = resolvePlan(selection).steps;
    const before = plan
      .slice(
        0,
        plan.findIndex((s) => s.id === "OFFERS")
      )
      .map((s) => s.id);
    const seeded = await seed(store, { selection, completedMessSteps: before });
    const executed: [MessStepDef, MessContext][] = [];
    const res = await step(seeded.id, { stepId: "OFFERS" }, messDeps(store, executed));

    expect(await outcome(res)).toEqual({
      status: 200,
      body: { stepId: "OFFERS", txHash: "a".repeat(64) },
    });
    expect(executed).toHaveLength(1);
    const [planned, ctx] = executed[0]!;
    expect(planned).toEqual(plan.find((s) => s.id === "OFFERS")!);
    expect(planned.action).toMatchObject({ kind: "offers" });
    expect(planned.action.kind === "offers" && planned.action.offers.length).toBe(2);
    expect(ctx.demo.publicKey()).toBe(seeded.demo.publicKey());
    expect(ctx.ephemeralIssuers.get("RUGPULL")?.publicKey()).toBe(
      seeded.issuers.get("RUGPULL")!.publicKey()
    );
    expect(ctx.persistentIssuer.publicKey()).toBe(issuer.publicKey());
    expect(ctx.mmPublic).toBe(mm.publicKey());
    expect((await store.loadSession(seeded.id))?.completedMessSteps).toEqual([...before, "OFFERS"]);
  });

  test("a light session refuses a step its plan does not contain, and nothing runs", async () => {
    const store = memoryStore();
    const seeded = await seed(store, {
      selection: selectionForMode("light"),
      ephemeralIssuers: [],
    });
    const executed: [MessStepDef, MessContext][] = [];
    for (const stepId of ["ADD_SIGNER", "TRUST_USDC"]) {
      expect(await outcome(await step(seeded.id, { stepId }, messDeps(store, executed)))).toEqual({
        status: 400,
        body: { error: "step_not_in_plan" },
      });
    }
    expect(executed).toEqual([]);
    expect((await store.loadSession(seeded.id))?.recordedSigners).toEqual([]);
  });

  test("a step ahead of the plan's order is step_out_of_order and nothing runs", async () => {
    const store = memoryStore();
    const seeded = await seed(store);
    const executed: [MessStepDef, MessContext][] = [];
    expect(
      await outcome(await step(seeded.id, { stepId: "ADD_SIGNER" }, messDeps(store, executed)))
    ).toEqual({ status: 409, body: { error: "step_out_of_order" } });
    expect(executed).toEqual([]);
  });

  test("a signer the step records is persisted on the session, its secret encrypted", async () => {
    const store = memoryStore();
    const plan = getMessPlanForMode("standard").map((s) => s.id);
    const seeded = await seed(store, {
      completedMessSteps: plan.filter((id) => id !== "ADD_SIGNER"),
    });
    const forgotten = Keypair.random().publicKey();
    const cosigner = Keypair.random();
    const res = await step(
      seeded.id,
      { stepId: "ADD_SIGNER" },
      {
        ...messDeps(store),
        executeMessStep: async (_planned, ctx) => {
          const base = { type: "ed25519_public_key" as const, weight: 1 };
          await ctx.recordSigner({ ...base, key: forgotten, secret: null });
          await ctx.recordSigner({ ...base, key: cosigner.publicKey(), secret: cosigner.secret() });
          return "b".repeat(64);
        },
      }
    );
    expect(res.status).toBe(200);
    expect(JSON.stringify(await jsonBody(res))).not.toContain(cosigner.secret());
    expect((await store.loadSession(seeded.id))?.recordedSigners).toEqual([
      { type: "ed25519_public_key", key: forgotten, weight: 1, encSecret: null },
      {
        type: "ed25519_public_key",
        key: cosigner.publicKey(),
        weight: 1,
        encSecret: encrypt(cosigner.secret()),
      },
    ]);
  });

  test("a body that is not a JSON object is invalid_json", async () => {
    const store = memoryStore();
    const seeded = await seed(store);
    for (const body of ["{", "null", "7"]) {
      expect(await outcome(await step(seeded.id, body, messDeps(store)))).toEqual({
        status: 400,
        body: { error: "invalid_json" },
      });
    }
  });

  test("an unknown or missing step id is invalid_step and nothing runs", async () => {
    const store = memoryStore();
    const seeded = await seed(store);
    const executed: [MessStepDef, MessContext][] = [];
    for (const body of [{}, { stepId: 3 }, { stepId: "DROP_TABLE" }, { stepId: "setup" }]) {
      expect(await outcome(await step(seeded.id, body, messDeps(store, executed)))).toEqual({
        status: 400,
        body: { error: "invalid_step" },
      });
    }
    expect(executed).toEqual([]);
  });

  test("a missing issuer or market maker key is not_configured", async () => {
    const store = memoryStore();
    const seeded = await seed(store);
    for (const missing of [{ issuer: () => null }, { mm: () => null }]) {
      const res = await step(seeded.id, { stepId: "SETUP" }, { ...messDeps(store), ...missing });
      expect(await outcome(res)).toEqual(NOT_CONFIGURED);
    }
  });

  test("an unknown, malformed or expired session is session_not_found", async () => {
    const clock = fakeClock();
    const store = memoryStore(clock);
    const seeded = await seed(store);
    expect(await outcome(await step(UNKNOWN_ID, { stepId: "SETUP" }, messDeps(store)))).toEqual(
      NOT_FOUND
    );
    expect(await outcome(await step(NOT_A_UUID, { stepId: "SETUP" }, messDeps(store)))).toEqual(
      NOT_FOUND
    );
    expired(clock);
    expect(await outcome(await step(seeded.id, { stepId: "SETUP" }, messDeps(store)))).toEqual(
      NOT_FOUND
    );
  });

  test("a step already run is step_already_executed, and a held session is step_in_progress", async () => {
    const store = memoryStore();
    const seeded = await seed(store, { completedMessSteps: ["SETUP"] });
    expect(await outcome(await step(seeded.id, { stepId: "SETUP" }, messDeps(store)))).toEqual({
      status: 409,
      body: { error: "step_already_executed" },
    });

    const lock = await store.acquireLock(seeded.id);
    expect(lock).not.toBeNull();
    expect(
      await outcome(await step(seeded.id, { stepId: "TRUST_LWDEMO" }, messDeps(store)))
    ).toEqual({ status: 409, body: { error: "step_in_progress" } });
  });

  test("a failed transaction is tx_failed", async () => {
    const store = memoryStore();
    const seeded = await seed(store);
    const res = await step(
      seeded.id,
      { stepId: "SETUP" },
      {
        ...messDeps(store),
        executeMessStep: async () => {
          throw new Error("op_underfunded");
        },
      }
    );
    expect(await outcome(res)).toEqual({ status: 502, body: { error: "tx_failed" } });
  });
});

// ─── POST /api/session/[id]/demolish/round ─────────────────────────────────────

describe("demolish", () => {
  const issuer = Keypair.random();
  const mm = Keypair.random();
  const api = { apiUrl: "http://localhost:3001", apiKey: "test-api-key" };
  const CLOSE_ENTRY = { txId: "tx-1", hash: "c".repeat(64), summary: "Close", operations: [] };

  function demolishDeps(store: SessionStore, runs: RunDemolishOptions[] = []) {
    return {
      store,
      issuer: () => issuer,
      mm: () => mm,
      api: () => api,
      feeAccount: () => null,
      mediatorKey: () => null,
      decrypt,
      runDemolish: async (opts: RunDemolishOptions) => {
        runs.push(opts);
        opts.hooks.onConfirmed(CLOSE_ENTRY, true);
        return { done: true, remainingSteps: 0 };
      },
    };
  }

  test("the round runs against the session record and marks the session done", async () => {
    const store = memoryStore();
    const signer = Keypair.random().publicKey();
    const seeded = await seed(store, {
      recordedSigners: [{ type: "ed25519_public_key", key: signer, weight: 1, encSecret: null }],
    });
    const runs: RunDemolishOptions[] = [];
    const res = await handleDemolishRound(seeded.id, demolishDeps(store, runs));

    expect(await outcome(res)).toEqual({
      status: 200,
      body: { done: true, confirmed: [CLOSE_ENTRY], remainingSteps: 0 },
    });
    expect(runs).toHaveLength(1);
    const opts = runs[0]!;
    expect(opts.demoKeypair.publicKey()).toBe(seeded.demo.publicKey());
    expect([opts.apiUrl, opts.apiKey]).toEqual([api.apiUrl, api.apiKey]);
    expect(opts.expected).toMatchObject({
      demoPublic: seeded.demo.publicKey(),
      sinkPublic: mm.publicKey(),
      recordedSigners: [{ type: "ed25519_public_key", key: signer }],
      offerCount: 3,
      dataEntryCount: 3,
    });
    expect(opts.expected.assets[0]).toEqual({ code: "LWDEMO", issuer: issuer.publicKey() });

    const stored = await store.loadSession(seeded.id);
    expect(stored?.demolishDone).toBe(true);
    expect(stored?.demolishLog.map((e) => e.txId)).toEqual(["tx-1"]);
  });

  test("a session already demolished answers done without closing again", async () => {
    const store = memoryStore();
    const seeded = await seed(store, { demolishDone: true });
    const runs: RunDemolishOptions[] = [];
    expect(await outcome(await handleDemolishRound(seeded.id, demolishDeps(store, runs)))).toEqual({
      status: 200,
      body: { done: true, confirmed: [], remainingSteps: 0 },
    });
    expect(runs).toEqual([]);
  });

  test("any missing key or API setting is not_configured, before the store is read", async () => {
    const store = memoryStore();
    const seeded = await seed(store);
    const counted = countingStore(store);
    const variants = [
      { mm: () => null },
      { issuer: () => null },
      { api: () => ({ ...api, apiUrl: undefined }) },
      { api: () => ({ ...api, apiKey: "" }) },
    ];
    for (const variant of variants) {
      const deps = { ...demolishDeps(counted.store), ...variant };
      expect(await outcome(await handleDemolishRound(seeded.id, deps))).toEqual(NOT_CONFIGURED);
    }
    expect(counted.calls()).toBe(0);
  });

  test("an unknown or expired session is session_not_found", async () => {
    const clock = fakeClock();
    const store = memoryStore(clock);
    const seeded = await seed(store);
    expect(await outcome(await handleDemolishRound(NOT_A_UUID, demolishDeps(store)))).toEqual(
      NOT_FOUND
    );
    expired(clock);
    expect(await outcome(await handleDemolishRound(seeded.id, demolishDeps(store)))).toEqual(
      NOT_FOUND
    );
  });

  test("a round that is not the last answers not done, with what it confirmed and what is left", async () => {
    const store = memoryStore();
    const seeded = await seed(store);
    const entry = { ...CLOSE_ENTRY, txId: "tx-0", hash: "d".repeat(64) };
    const res = await handleDemolishRound(seeded.id, {
      ...demolishDeps(store),
      runDemolish: async (opts) => {
        opts.hooks.onConfirmed(entry, false);
        return { done: false, remainingSteps: 2 };
      },
    });
    expect(await outcome(res)).toEqual({
      status: 200,
      body: { done: false, confirmed: [entry], remainingSteps: 2 },
    });
    expect((await store.loadSession(seeded.id))?.demolishDone).toBe(false);
  });

  test("a decision the playground cannot make stops the round with the decision ids, bounded", async () => {
    const store = memoryStore();
    const seeded = await seed(store);
    const ids = Array.from({ length: 12 }, (_, i) => `claim:${String(i).padStart(250, "0")}`);
    const res = await handleDemolishRound(seeded.id, {
      ...demolishDeps(store),
      runDemolish: async () => {
        throw new DemolishDecisionUnanswerableError(ids);
      },
    });
    expect(await outcome(res)).toEqual({
      status: 422,
      body: {
        error: "demolish_decision_unanswerable",
        decisions: ids.slice(0, 10).map((id) => id.slice(0, 200)),
      },
    });
    expect((await store.loadSession(seeded.id))?.demolishDone).toBe(false);
  });

  test("a failed close is demolish_failed and leaves the session not done", async () => {
    const store = memoryStore();
    const seeded = await seed(store);
    const res = await handleDemolishRound(seeded.id, {
      ...demolishDeps(store),
      runDemolish: async () => {
        throw new Error("verification refused");
      },
    });
    expect(await outcome(res)).toEqual({ status: 502, body: { error: "demolish_failed" } });
    expect((await store.loadSession(seeded.id))?.demolishDone).toBe(false);
  });
});

// ─── POST /api/session/[id]/resolve ─────────────────────────────────────────────

describe("resolve", () => {
  const claimant = Keypair.random();
  const beneficiary = Keypair.random();
  const perk = Keypair.random();
  const SPONSORED_ID = `00000000${"5".repeat(64)}`;
  const CLAIMS: ScenarioSelection = {
    scenarios: [
      { id: "claimable-balances", params: { add_trustline: 0, time_gated: 0, demo_sponsored: 1 } },
    ],
  };
  const UNREVOCABLE: ScenarioSelection = {
    scenarios: [{ id: "sponsored-reserves", params: { variant: 2 } }],
  };
  const helper = (role: "claimant" | "beneficiary", kp: Keypair) => ({
    role,
    publicKey: kp.publicKey(),
    encSecret: encrypt(kp.secret()),
  });

  async function seedClaims(store: SessionStore, overrides: Partial<NewSessionData> = {}) {
    return seed(store, {
      selection: CLAIMS,
      completedMessSteps: resolvePlan(CLAIMS).steps.map((st) => st.id),
      helperAccounts: [helper("claimant", claimant)],
      claimableBalances: [
        { id: `00000000${"4".repeat(64)}`, asset: "BONUS:GISSUER", intent: "claim" },
        { id: SPONSORED_ID, asset: "native", intent: "demo_sponsored" },
      ],
      ...overrides,
    });
  }

  function resolveDeps(store: SessionStore, sent: [string, xdr.Operation[]][] = []) {
    return {
      store,
      decrypt,
      submit: async (source: Keypair, ops: xdr.Operation[]) => {
        sent.push([source.publicKey(), ops]);
        return "f".repeat(64);
      },
    };
  }
  const resolve = (id: string, body: unknown, deps: Parameters<typeof handleResolve>[2]) =>
    handleResolve(
      request(`/api/session/${id}/resolve`, {
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
      id,
      deps
    );
  const decoded = (ops: xdr.Operation[]) => ops.map((op) => Operation.fromXDRObject(op));

  test("the claimant claims the balance the demo created, with its own key", async () => {
    const store = memoryStore();
    const seeded = await seedClaims(store);
    const sent: [string, xdr.Operation[]][] = [];
    const res = await resolve(
      seeded.id,
      { blocker: "sponsorship_claimable_balance_unrevocable" },
      resolveDeps(store, sent)
    );
    expect(await outcome(res)).toEqual({
      status: 200,
      body: {
        ok: true,
        blocker: "sponsorship_claimable_balance_unrevocable",
        txHash: "f".repeat(64),
      },
    });
    expect(sent.map(([source]) => source)).toEqual([claimant.publicKey()]);
    const [claim] = decoded(sent[0]![1]);
    if (claim?.type !== "claimClaimableBalance") throw new Error("expected a claim");
    expect(claim.balanceId).toBe(SPONSORED_ID);
  });

  test("the beneficiary releases its own sponsored entries, with its own key", async () => {
    const store = memoryStore();
    const seeded = await seed(store, {
      selection: UNREVOCABLE,
      ephemeralIssuers: [
        { assetCode: "PERK", publicKey: perk.publicKey(), encSecret: encrypt(perk.secret()) },
      ],
      completedMessSteps: resolvePlan(UNREVOCABLE).steps.map((st) => st.id),
      helperAccounts: [helper("beneficiary", beneficiary)],
    });
    const sent: [string, xdr.Operation[]][] = [];
    const res = await resolve(
      seeded.id,
      { blocker: "sponsorship_unaffordable" },
      resolveDeps(store, sent)
    );
    expect(res.status).toBe(200);
    expect(sent.map(([source]) => source)).toEqual([beneficiary.publicKey()]);
    const [trust, data] = decoded(sent[0]![1]);
    if (trust?.type !== "changeTrust" || data?.type !== "manageData") {
      throw new Error("expected a trustline and a data entry removal");
    }
    expect([trust.limit, data.name, data.value]).toEqual([
      "0.0000000",
      "sponsored_by_demo",
      undefined,
    ]);
  });

  test("a blocker the session's plan has no resolution for is refused, and nothing is sent", async () => {
    const store = memoryStore();
    const seeded = await seedClaims(store);
    const sent: [string, xdr.Operation[]][] = [];
    for (const blocker of ["sponsorship_unaffordable", "plan_blocker", "x".repeat(65), "", 7]) {
      expect(
        await outcome(await resolve(seeded.id, { blocker }, resolveDeps(store, sent)))
      ).toEqual({
        status: 400,
        body: { error: "resolution_unavailable" },
      });
    }
    expect(sent).toEqual([]);
  });

  test("a resolution the session has not recorded what it needs for is refused", async () => {
    const variants: Partial<NewSessionData>[] = [
      { claimableBalances: [] },
      { helperAccounts: [] },
      { completedMessSteps: ["SETUP"] },
    ];
    for (const overrides of variants) {
      const store = memoryStore();
      const seeded = await seedClaims(store, overrides);
      const sent: [string, xdr.Operation[]][] = [];
      expect(
        await outcome(
          await resolve(
            seeded.id,
            { blocker: "sponsorship_claimable_balance_unrevocable" },
            resolveDeps(store, sent)
          )
        )
      ).toEqual({ status: 409, body: { error: "resolution_not_recorded" } });
      expect(sent).toEqual([]);
    }
  });

  test("a resolution while a close transaction is in flight, or after the close, is refused", async () => {
    const pending = {
      txId: "t",
      hash: "h",
      summary: "s",
      operations: [],
      validUntil: null,
      closesAccount: false,
      recordedBalance: null,
    };
    for (const overrides of [{ demolishPending: pending }, { demolishDone: true }]) {
      const store = memoryStore();
      const seeded = await seedClaims(store, overrides);
      const sent: [string, xdr.Operation[]][] = [];
      expect(
        await outcome(
          await resolve(
            seeded.id,
            { blocker: "sponsorship_claimable_balance_unrevocable" },
            resolveDeps(store, sent)
          )
        )
      ).toEqual({ status: 409, body: { error: "demolish_in_progress" } });
      expect(sent).toEqual([]);
    }
  });

  test("a resolution while another request holds the session is refused, and nothing is sent", async () => {
    const store = memoryStore();
    const seeded = await seedClaims(store);
    const held = await store.acquireLock(seeded.id);
    if (!held) throw new Error("expected the lock");
    const sent: [string, xdr.Operation[]][] = [];
    expect(
      await outcome(
        await resolve(
          seeded.id,
          { blocker: "sponsorship_claimable_balance_unrevocable" },
          resolveDeps(store, sent)
        )
      )
    ).toEqual({ status: 409, body: { error: "step_in_progress" } });
    expect(sent).toEqual([]);
  });

  test("a failed send is resolve_failed; a bad body is invalid_json; an unknown session is not found", async () => {
    const store = memoryStore();
    const seeded = await seedClaims(store);
    const failing = {
      ...resolveDeps(store),
      submit: async () => {
        throw new Error("op_does_not_exist");
      },
    };
    expect(
      await outcome(
        await resolve(seeded.id, { blocker: "sponsorship_claimable_balance_unrevocable" }, failing)
      )
    ).toEqual({ status: 502, body: { error: "resolve_failed" } });
    expect(await outcome(await resolve(seeded.id, "{", resolveDeps(store)))).toEqual({
      status: 400,
      body: { error: "invalid_json" },
    });
    expect(
      await outcome(
        await resolve(
          UNKNOWN_ID,
          { blocker: "sponsorship_claimable_balance_unrevocable" },
          resolveDeps(store)
        )
      )
    ).toEqual(NOT_FOUND);
  });
});

// ─── POST /api/session/[id]/cleanup ────────────────────────────────────────────

describe("allowances", () => {
  const ALLOWANCES: ScenarioSelection = {
    scenarios: [{ id: "allowances", params: { spenders: 2 } }],
  };
  const first = Keypair.random().publicKey();
  const second = Keypair.random().publicKey();
  const RECORDED = [
    { token: XLM_SAC, spender: first, liveUntilLedger: 9_000_000 },
    { token: XLM_SAC, spender: second, liveUntilLedger: 5_200_000 },
  ];
  const API = () => ({ apiUrl: "https://api.example", apiKey: "test-key" });

  interface ApiLog {
    asked: unknown[];
    submitted: string[];
    listed: string[];
  }

  function allowanceDeps(
    store: SessionStore,
    log: ApiLog,
    build: (owner: string, spender: string) => string = (owner, spender) =>
      revokeTx({ owner, spender }).toEnvelope().toXDR("base64")
  ) {
    const api: AllowanceApi = {
      getAllowances: async (address) => {
        log.listed.push(address);
        return {
          allowances: [
            // The API lists the second spender only (its list is best effort), and one the
            // session never recorded, which is left out.
            { token: XLM_SAC, spender: second, amount: "250000000" },
            { token: XLM_SAC, spender: Keypair.random().publicKey(), amount: "1" },
          ] as never,
        };
      },
      revokeAllowance: async (params) => {
        log.asked.push(params);
        return { transaction: build(params.owner, params.spender) };
      },
      submit: async (signedXdr) => {
        log.submitted.push(signedXdr);
        return { hash: "0".repeat(64) };
      },
    };
    return {
      store,
      api: API,
      decrypt,
      allowanceApi: () => api,
      signerState: async (address: string) => ({
        signers: [{ key: address, type: "ed25519_public_key", weight: 1 }],
        thresholds: { low: 0, med: 0, high: 0 },
      }),
    };
  }
  const newLog = (): ApiLog => ({ asked: [], submitted: [], listed: [] });
  const revoke = (id: string, body: unknown, deps: Parameters<typeof handleRevokeAllowance>[2]) =>
    handleRevokeAllowance(
      request(`/api/session/${id}/allowances/revoke`, {
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
      id,
      deps
    );

  test("the list is the session's record, each marked with whether the API lists it", async () => {
    const store = memoryStore();
    const seeded = await seed(store, { selection: ALLOWANCES, allowances: RECORDED });
    const log = newLog();
    const res = await handleAllowances(seeded.id, allowanceDeps(store, log));
    expect(await outcome(res)).toEqual({
      status: 200,
      body: {
        allowances: [
          { index: 1, token: XLM_SAC, spender: first, listed: false, amount: null },
          { index: 2, token: XLM_SAC, spender: second, listed: true, amount: "250000000" },
        ],
      },
    });
    expect(log.listed).toEqual([seeded.demo.publicKey()]);
  });

  test("a session that recorded no allowance asks the API for none", async () => {
    const store = memoryStore();
    const seeded = await seed(store);
    const log = newLog();
    const res = await handleAllowances(seeded.id, allowanceDeps(store, log));
    expect(await outcome(res)).toEqual({ status: 200, body: { allowances: [] } });
    expect(log.listed).toEqual([]);
  });

  test("a recorded spender is revoked with the demo key, under the session lock", async () => {
    const store = memoryStore();
    const seeded = await seed(store, { selection: ALLOWANCES, allowances: RECORDED });
    const log = newLog();
    const res = await revoke(seeded.id, { spender: second }, allowanceDeps(store, log));
    const body = (await res.json()) as { spender: string; txHash: string };
    expect(res.status).toBe(200);
    expect(log.asked).toEqual([
      { owner: seeded.demo.publicKey(), token: XLM_SAC, spender: second },
    ]);
    const signed = TransactionBuilder.fromXDR(log.submitted[0]!, Networks.TESTNET) as Transaction;
    expect(signed.signatures).toHaveLength(1);
    expect(
      seeded.demo.verify(signed.hash(), Buffer.from(signed.signatures[0]!.signature.value))
    ).toBe(true);
    // The hash is the playground's own, from the envelope it signed.
    expect(body).toEqual({ spender: second, txHash: Buffer.from(signed.hash()).toString("hex") });
  });

  test("a revoke while another action holds the lock is turned away", async () => {
    const store = memoryStore();
    const seeded = await seed(store, { selection: ALLOWANCES, allowances: RECORDED });
    const lock = await store.acquireLock(seeded.id);
    const log = newLog();
    const res = await revoke(seeded.id, { spender: second }, allowanceDeps(store, log));
    expect(await outcome(res)).toEqual({ status: 409, body: { error: "step_in_progress" } });
    expect(log.asked).toEqual([]);
    await store.releaseLock(lock!);
  });

  test("a spender the session did not record, or a malformed body, signs nothing", async () => {
    const store = memoryStore();
    const seeded = await seed(store, { selection: ALLOWANCES, allowances: RECORDED });
    const log = newLog();
    const deps = allowanceDeps(store, log);
    const stranger = Keypair.random().publicKey();
    for (const [body, error] of [
      [{ spender: stranger }, "allowance_not_recorded"],
      [{ spender: 7 }, "allowance_not_recorded"],
      [{ spender: "G".repeat(57) }, "allowance_not_recorded"],
      ["not json", "invalid_json"],
    ] as const) {
      const res = await revoke(seeded.id, body, deps);
      expect(await outcome(res)).toEqual({ status: 400, body: { error } });
    }
    expect([log.asked, log.submitted]).toEqual([[], []]);
  });

  test("a revoke the API builds for another spender is refused and never sent", async () => {
    const store = memoryStore();
    const seeded = await seed(store, { selection: ALLOWANCES, allowances: RECORDED });
    const log = newLog();
    const swapped = allowanceDeps(store, log, (owner) =>
      revokeTx({ owner, spender: Keypair.random().publicKey() }).toEnvelope().toXDR("base64")
    );
    const res = await revoke(seeded.id, { spender: second }, swapped);
    expect(await outcome(res)).toEqual({ status: 422, body: { error: "revoke_refused" } });
    expect(log.submitted).toEqual([]);
    expect(errorCopy("revoke_refused")).toContain("nothing was signed");
  });

  test("without the API setting, nothing is read or signed", async () => {
    const store = memoryStore();
    const seeded = await seed(store, { selection: ALLOWANCES, allowances: RECORDED });
    const log = newLog();
    const deps = {
      ...allowanceDeps(store, log),
      api: () => ({ apiUrl: undefined, apiKey: undefined }),
    };
    expect(await outcome(await revoke(seeded.id, { spender: second }, deps))).toEqual(
      NOT_CONFIGURED
    );
    expect(await outcome(await handleAllowances(seeded.id, deps))).toEqual(NOT_CONFIGURED);
    expect([log.asked, log.listed]).toEqual([[], []]);
  });
});

describe("cleanup", () => {
  const mm = Keypair.random();
  const issuer = Keypair.random();

  function cleanupDeps(store: SessionStore, overrides: Partial<CleanupRouteDeps> = {}) {
    const merges: [string, string][] = [];
    const deps: CleanupRouteDeps = {
      store,
      mm: () => mm,
      issuer: () => issuer,
      decrypt,
      exists: async () => true,
      merge: async (source, destination) => {
        merges.push([source.publicKey(), destination]);
      },
      submit: async () => {
        throw new Error("no recipient in this session");
      },
      ...overrides,
    };
    return { deps, merges };
  }

  test("after the close every ephemeral issuer is merged into the market maker and the session deleted", async () => {
    const store = memoryStore();
    const seeded = await seed(store, { demolishDone: true });
    const { deps, merges } = cleanupDeps(store);
    const res = await handleCleanup(seeded.id, deps);
    const issuers = [...seeded.issuers.values()].map((kp) => kp.publicKey());
    expect(await outcome(res)).toEqual({ status: 200, body: { ok: true, recycled: issuers } });
    expect(merges).toEqual(issuers.map((pub) => [pub, mm.publicKey()]));
    expect(await store.loadSession(seeded.id)).toBeNull();
    expect(await store.indexedSessionIds()).toEqual([]);
  });

  test("before the close the demo is merged first, then everything else", async () => {
    const store = memoryStore();
    const seeded = await seed(store);
    const { deps, merges } = cleanupDeps(store);
    const res = await handleCleanup(seeded.id, deps);
    const issuers = [...seeded.issuers.values()].map((kp) => kp.publicKey());
    expect(await outcome(res)).toEqual({
      status: 200,
      body: { ok: true, recycled: [seeded.demo.publicKey(), ...issuers] },
    });
    expect(merges.map(([source]) => source)).toEqual([seeded.demo.publicKey(), ...issuers]);
    expect(await store.loadSession(seeded.id)).toBeNull();
  });

  test("a demo that cannot merge yet keeps every account and the record, issuers included", async () => {
    const store = memoryStore();
    const seeded = await seed(store);
    const { deps, merges } = cleanupDeps(store, {
      merge: async (source) => {
        merges.push([source.publicKey(), ""]);
        throw new TxSubmitError("Transaction rejected: op_has_sub_entries", "tx_failed");
      },
    });
    const res = await handleCleanup(seeded.id, deps);
    expect(await outcome(res)).toEqual({ status: 502, body: { error: "cleanup_failed" } });
    expect(merges.map(([source]) => source)).toEqual([seeded.demo.publicKey()]);
    expect((await store.loadSession(seeded.id))?.ephemeralIssuers).toHaveLength(2);
    expect(await store.indexedSessionIds()).toEqual([seeded.id]);
  });

  test("a close transaction in flight is left to the close: nothing is merged", async () => {
    const store = memoryStore();
    const seeded = await seed(store, {
      demolishPending: {
        txId: "t1",
        hash: "a".repeat(64),
        summary: "close",
        operations: [],
        validUntil: null,
        closesAccount: true,
        recordedBalance: null,
      },
    });
    const { deps, merges } = cleanupDeps(store);
    const res = await handleCleanup(seeded.id, deps);
    expect(await outcome(res)).toEqual({ status: 502, body: { error: "cleanup_failed" } });
    expect(merges).toEqual([]);
    expect(await store.loadSession(seeded.id)).not.toBeNull();
  });

  test("an account already gone counts as recycled without a transaction", async () => {
    const store = memoryStore();
    const seeded = await seed(store);
    const { deps, merges } = cleanupDeps(store, { exists: async () => false });
    const res = await handleCleanup(seeded.id, deps);
    expect(res.status).toBe(200);
    expect(merges).toEqual([]);
    expect(await store.loadSession(seeded.id)).toBeNull();
  });

  test("a failed merge keeps the record without what was recycled, and the next cleanup finishes", async () => {
    const store = memoryStore();
    const seeded = await seed(store, { demolishDone: true });
    const rugpull = seeded.issuers.get("RUGPULL")!.publicKey();
    const airdrop = seeded.issuers.get("AIRDROP1")!.publicKey();
    const first = cleanupDeps(store, {
      merge: async (source) => {
        if (source.publicKey() !== rugpull) throw new Error("tx_bad_seq");
      },
    });
    expect(await outcome(await handleCleanup(seeded.id, first.deps))).toEqual({
      status: 502,
      body: { error: "cleanup_failed" },
    });
    const kept = await store.loadSession(seeded.id);
    expect(kept?.ephemeralIssuers.map((e) => e.publicKey)).toEqual([airdrop]);

    const second = cleanupDeps(store);
    expect(await outcome(await handleCleanup(seeded.id, second.deps))).toEqual({
      status: 200,
      body: { ok: true, recycled: [airdrop] },
    });
    expect(second.merges.map(([source]) => source)).toEqual([airdrop]);
    expect(await store.loadSession(seeded.id)).toBeNull();
  });

  test("an unreadable account is not taken for gone: the record is kept", async () => {
    const store = memoryStore();
    const seeded = await seed(store, { demolishDone: true });
    const { deps, merges } = cleanupDeps(store, {
      exists: async () => {
        throw new Error("Horizon account fetch failed (503)");
      },
    });
    expect((await handleCleanup(seeded.id, deps)).status).toBe(502);
    expect(merges).toEqual([]);
    expect((await store.loadSession(seeded.id))?.ephemeralIssuers).toHaveLength(2);
  });

  test("with no market maker or issuer key nothing is merged and the record is kept", async () => {
    for (const missing of [{ mm: () => null }, { issuer: () => null }]) {
      const store = memoryStore();
      const seeded = await seed(store, { demolishDone: true });
      const { deps, merges } = cleanupDeps(store, missing);
      expect(await outcome(await handleCleanup(seeded.id, deps))).toEqual(NOT_CONFIGURED);
      expect(merges).toEqual([]);
      expect(await store.loadSession(seeded.id)).not.toBeNull();
    }
  });

  describe("helpers and forfeited balances", () => {
    test("a claimant or sponsor merges; a beneficiary releases its entries in its merge", async () => {
      const store = memoryStore();
      const perk = Keypair.random();
      const [claimant, beneficiary] = [Keypair.random(), Keypair.random()];
      const seeded = await seed(store, {
        demolishDone: true,
        selection: {
          scenarios: [
            { id: "claimable-balances", params: { demo_sponsored: 1 } },
            { id: "sponsored-reserves", params: { variant: 1 } },
          ],
        },
        ephemeralIssuers: [
          { assetCode: "PERK", publicKey: perk.publicKey(), encSecret: encrypt(perk.secret()) },
        ],
        helperAccounts: [
          {
            role: "claimant",
            publicKey: claimant.publicKey(),
            encSecret: encrypt(claimant.secret()),
          },
          {
            role: "beneficiary",
            publicKey: beneficiary.publicKey(),
            encSecret: encrypt(beneficiary.secret()),
          },
        ],
      });
      const submitted: [string, string[]][] = [];
      const { deps, merges } = cleanupDeps(store, {
        submit: async (source, ops) => {
          submitted.push([source.publicKey(), ops.map((op) => Operation.fromXDRObject(op).type)]);
        },
      });
      const res = await handleCleanup(seeded.id, deps);
      expect(await outcome(res)).toEqual({
        status: 200,
        body: {
          ok: true,
          recycled: [claimant.publicKey(), beneficiary.publicKey(), perk.publicKey()],
        },
      });
      expect(submitted).toEqual([
        [beneficiary.publicKey(), ["changeTrust", "manageData", "accountMerge"]],
      ]);
      expect(merges.map(([source]) => source)).toEqual([claimant.publicKey(), perk.publicKey()]);
    });

    test("a beneficiary whose entries are already gone merges plainly", async () => {
      const store = memoryStore();
      const perk = Keypair.random();
      const beneficiary = Keypair.random();
      const seeded = await seed(store, {
        demolishDone: true,
        selection: { scenarios: [{ id: "sponsored-reserves", params: { variant: 2 } }] },
        ephemeralIssuers: [
          { assetCode: "PERK", publicKey: perk.publicKey(), encSecret: encrypt(perk.secret()) },
        ],
        helperAccounts: [
          {
            role: "beneficiary",
            publicKey: beneficiary.publicKey(),
            encSecret: encrypt(beneficiary.secret()),
          },
        ],
      });
      const { deps, merges } = cleanupDeps(store, {
        submit: async () => {
          throw new Error("op_no_trust");
        },
      });
      await handleCleanup(seeded.id, deps);
      expect(merges.map(([source]) => source)).toEqual([beneficiary.publicKey(), perk.publicKey()]);
    });

    test("an issuer claims back the balance the demo forfeited before it merges", async () => {
      const store = memoryStore();
      const bonus = Keypair.random();
      const LATE = `00000000${"6".repeat(64)}`;
      const seeded = await seed(store, {
        demolishDone: true,
        selection: { scenarios: [{ id: "claimable-balances", params: { time_gated: 1 } }] },
        ephemeralIssuers: [
          { assetCode: "BONUS", publicKey: bonus.publicKey(), encSecret: encrypt(bonus.secret()) },
        ],
        claimableBalances: [
          { id: `00000000${"7".repeat(64)}`, asset: `BONUS:${bonus.publicKey()}`, intent: "claim" },
          { id: LATE, asset: `BONUS:${bonus.publicKey()}`, intent: "forfeit" },
        ],
      });
      const order: string[] = [];
      const { deps } = cleanupDeps(store, {
        merge: async (source) => {
          order.push(`merge ${source.publicKey()}`);
        },
        submit: async (source, ops) => {
          const claims = ops.map((op) => Operation.fromXDRObject(op));
          for (const claim of claims) {
            if (claim.type !== "claimClaimableBalance") throw new Error("expected a claim");
            order.push(`claim ${source.publicKey()} ${claim.balanceId}`);
          }
        },
      });
      await handleCleanup(seeded.id, deps);
      expect(order).toEqual([`claim ${bonus.publicKey()} ${LATE}`, `merge ${bonus.publicKey()}`]);
    });
  });

  describe("the transfer recipient", () => {
    const recipient = Keypair.random();
    const TRANSFERRING: ScenarioSelection = {
      scenarios: [{ id: "dispositions", params: { lwcoin: 2, lwgem: 2 } }],
    };

    async function retire(done: boolean, submit?: (source: Keypair) => Promise<void>) {
      const store = memoryStore();
      const seeded = await seed(store, {
        selection: TRANSFERRING,
        ephemeralIssuers: [],
        demolishDone: done,
        transferRecipient: {
          publicKey: recipient.publicKey(),
          encSecret: encrypt(recipient.secret()),
        },
      });
      const submitted: [string, xdr.Operation[]][] = [];
      const { deps } = cleanupDeps(store, {
        submit: async (source, ops) => {
          submitted.push([source.publicKey(), ops]);
          await submit?.(source);
        },
      });
      const res = await handleCleanup(seeded.id, deps);
      return { res, submitted, store, id: seeded.id };
    }

    const types = (ops: xdr.Operation[]) => ops.map((op) => Operation.fromXDRObject(op).type);

    test("after the close it returns both balances, removes both trustlines and merges", async () => {
      const { res, submitted } = await retire(true);
      expect(await outcome(res)).toEqual({
        status: 200,
        body: { ok: true, recycled: [recipient.publicKey()] },
      });
      expect(submitted.map(([source]) => source)).toEqual([recipient.publicKey()]);
      expect(types(submitted[0]![1])).toEqual([
        "payment",
        "payment",
        "changeTrust",
        "changeTrust",
        "accountMerge",
      ]);
    });

    test("before the close it only removes the trustlines and merges", async () => {
      const { submitted } = await retire(false);
      expect(types(submitted[0]![1])).toEqual(["changeTrust", "changeTrust", "accountMerge"]);
    });

    test("a failed retirement keeps the recipient on the record for the next attempt", async () => {
      const { res, store, id } = await retire(true, async () => {
        throw new Error("op_underfunded");
      });
      expect(await outcome(res)).toEqual({ status: 502, body: { error: "cleanup_failed" } });
      expect((await store.loadSession(id))?.transferRecipient?.publicKey).toBe(
        recipient.publicKey()
      );
    });
  });

  test("an unknown session is session_not_found", async () => {
    const { deps } = cleanupDeps(memoryStore());
    expect(await outcome(await handleCleanup(UNKNOWN_ID, deps))).toEqual(NOT_FOUND);
    expect(await outcome(await handleCleanup(NOT_A_UUID, deps))).toEqual(NOT_FOUND);
  });
});

// ─── GET /api/session/[id]/credentials ─────────────────────────────────────────

describe("credentials", () => {
  const reveal = (id: string, deps: Parameters<typeof handleCredentials>[2]) =>
    handleCredentials(request(`/api/session/${id}/credentials`, { method: "GET" }), id, deps);

  test("a live session reveals its own demo key pair", async () => {
    const store = memoryStore();
    const seeded = await seed(store);
    const res = await reveal(seeded.id, { store, rateLimit: allow, decrypt });
    expect(await outcome(res)).toEqual({
      status: 200,
      body: { publicKey: seeded.demo.publicKey(), secretKey: seeded.demo.secret() },
    });
  });

  test("an over-limit caller gets 429 before the store is read or anything decrypted", async () => {
    const store = memoryStore();
    const seeded = await seed(store);
    const counted = countingStore(store);
    const limits: [string, number][] = [];
    let decrypted = 0;
    const res = await reveal(seeded.id, {
      store: counted.store,
      rateLimit: async (req, namespace, limitPerDay) => {
        limits.push([namespace, limitPerDay]);
        return deny(req, namespace, limitPerDay);
      },
      decrypt: (payload) => {
        decrypted++;
        return decrypt(payload);
      },
    });
    expect(await outcome(res)).toEqual({ status: 429, body: { error: "rate_limited" } });
    expect(limits).toEqual([["credentials", 50]]);
    expect(counted.calls()).toBe(0);
    expect(decrypted).toBe(0);
  });

  test("once the countdown ends no key is handed out, and nothing is decrypted", async () => {
    const store = memoryStore();
    const seeded = await seed(store, { expiresAt: 1_900_000_000_000 });
    let decrypted = 0;
    const deps = {
      store,
      rateLimit: allow,
      decrypt: (payload: string) => {
        decrypted++;
        return decrypt(payload);
      },
    };
    const atEnd = await reveal(seeded.id, { ...deps, now: () => 1_900_000_000_000 });
    expect(await outcome(atEnd)).toEqual({ status: 410, body: { error: "session_expired" } });
    expect(decrypted).toBe(0);
    const before = await reveal(seeded.id, { ...deps, now: () => 1_900_000_000_000 - 1 });
    expect(before.status).toBe(200);
  });

  test("an id that is not a session uuid is session_not_found without a store read", async () => {
    const counted = countingStore(memoryStore());
    const res = await reveal(NOT_A_UUID, { store: counted.store, rateLimit: allow, decrypt });
    expect(await outcome(res)).toEqual(NOT_FOUND);
    expect(counted.calls()).toBe(0);
  });

  test("an unknown or expired session is session_not_found", async () => {
    const clock = fakeClock();
    const store = memoryStore(clock);
    const seeded = await seed(store);
    const deps = { store, rateLimit: allow, decrypt };
    expect(await outcome(await reveal(UNKNOWN_ID, deps))).toEqual(NOT_FOUND);
    expired(clock);
    expect(await outcome(await reveal(seeded.id, deps))).toEqual(NOT_FOUND);
  });

  test("a missing encryption key or session store is not_configured", async () => {
    const store = memoryStore();
    const seeded = await seed(store);
    const noKey = await reveal(seeded.id, {
      store,
      rateLimit: allow,
      decrypt: () => {
        throw new PlaygroundConfigError("PLAYGROUND_ENCRYPTION_KEY is not set");
      },
    });
    expect(await outcome(noKey)).toEqual(NOT_CONFIGURED);

    const noStore = await reveal(seeded.id, {
      store: {
        ...store,
        loadSession: async () => {
          throw new PlaygroundStoreUnavailableError();
        },
      },
      rateLimit: allow,
      decrypt,
    });
    expect(await outcome(noStore)).toEqual(NOT_CONFIGURED);
  });

  test("a payload that fails to decrypt for any other reason is not answered as success", async () => {
    const store = memoryStore();
    const seeded = await seed(store, { encDemoSecret: "tampered" });
    await expect(reveal(seeded.id, { store, rateLimit: allow, decrypt })).rejects.toThrow();
  });
});

// ─── GET /api/session/[id]/state ───────────────────────────────────────────────

describe("state", () => {
  const api = { apiUrl: "http://localhost:3001", apiKey: "test-api-key" };
  const account = { accountId: "GSTATE", numSubEntries: 4 } as unknown as AccountState;

  test("a live session returns its progress and the account read through the API", async () => {
    const store = memoryStore();
    const seeded = await seed(store, { completedMessSteps: ["SETUP"] });
    const readers: [string, string][] = [];
    const reads: string[] = [];
    const res = await handleState(seeded.id, {
      store,
      api: () => api,
      accountReader: (apiUrl, apiKey) => {
        readers.push([apiUrl, apiKey]);
        return async (publicKey) => {
          reads.push(publicKey);
          return account;
        };
      },
    });
    expect(await outcome(res)).toEqual({
      status: 200,
      body: {
        demoPublic: seeded.demo.publicKey(),
        completedMessSteps: ["SETUP"],
        demolishLog: [],
        demolishDone: false,
        accountState: account,
      },
    });
    expect(readers).toEqual([[api.apiUrl, api.apiKey]]);
    expect(reads).toEqual([seeded.demo.publicKey()]);
  });

  test("a merged-away account is a null account state, not an error", async () => {
    const store = memoryStore();
    const seeded = await seed(store);
    const res = await handleState(seeded.id, {
      store,
      api: () => api,
      accountReader: () => async () => {
        throw new LumenWipeApiError(404, { error: { code: "not_found", message: "gone" } });
      },
    });
    expect(res.status).toBe(200);
    expect((await jsonBody(res)).accountState).toBeNull();
  });

  test("a failed account read is state_read_failed", async () => {
    const store = memoryStore();
    const seeded = await seed(store);
    const res = await handleState(seeded.id, {
      store,
      api: () => api,
      accountReader: () => async () => {
        throw new Error("socket hang up");
      },
    });
    expect(await outcome(res)).toEqual({ status: 502, body: { error: "state_read_failed" } });
  });

  test("a missing API setting is not_configured", async () => {
    const store = memoryStore();
    const seeded = await seed(store);
    for (const config of [
      { ...api, apiUrl: undefined },
      { ...api, apiKey: undefined },
    ]) {
      const res = await handleState(seeded.id, {
        store,
        api: () => config,
        accountReader: () => async () => account,
      });
      expect(await outcome(res)).toEqual(NOT_CONFIGURED);
    }
  });

  test("an unknown, malformed or expired session is session_not_found", async () => {
    const clock = fakeClock();
    const store = memoryStore(clock);
    const seeded = await seed(store);
    const deps = { store, api: () => api, accountReader: () => async () => account };
    expect(await outcome(await handleState(UNKNOWN_ID, deps))).toEqual(NOT_FOUND);
    expect(await outcome(await handleState(NOT_A_UUID, deps))).toEqual(NOT_FOUND);
    expired(clock);
    expect(await outcome(await handleState(seeded.id, deps))).toEqual(NOT_FOUND);
  });

  test("an unavailable session store is not_configured", async () => {
    const store = memoryStore();
    const seeded = await seed(store);
    const res = await handleState(seeded.id, {
      store: {
        ...store,
        loadSession: async () => {
          throw new PlaygroundStoreUnavailableError();
        },
      },
      api: () => api,
      accountReader: () => async () => account,
    });
    expect(await outcome(res)).toEqual(NOT_CONFIGURED);
  });
});
