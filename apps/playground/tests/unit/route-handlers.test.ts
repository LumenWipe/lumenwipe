import { describe, expect, test } from "bun:test";
import { NextRequest, NextResponse } from "next/server";
import { Keypair } from "@stellar/stellar-sdk";
import { LumenWipeApiError, type AccountState } from "@lumenwipe/sdk";
import { PlaygroundConfigError } from "@/lib/crypto";
import { DEFAULT_CUSTOM_CONFIG, getMessPlanForMode, type MessStepId } from "@/lib/mess-plan";
import type { MessContext } from "@/lib/mess-builders";
import type { RunDemolishOptions } from "@/lib/demolish";
import type { RateLimit } from "@/lib/rate-limit";
import {
  handleCleanup,
  handleCreateSession,
  handleCredentials,
  handleDemolish,
  handleMess,
  handleState,
  parseCreateBody,
  type CreateSessionDeps,
} from "@/lib/route-handlers";
import {
  PlaygroundStoreUnavailableError,
  SESSION_TTL_SECONDS,
  isSessionId,
  type NewSessionData,
  type SessionStore,
} from "@/lib/session-store";
import { fakeClock, memoryStore, newSessionData, type FakeClock } from "./session-fixtures";

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
    fundRareAssets: ["AIRDROP1", "RUGPULL"],
    offerCount: 3,
    dataEntryCount: 3,
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
    },
    calls: () => calls,
  };
}

const expired = (clock: FakeClock): void => clock.advance(SESSION_TTL_SECONDS * 1000 + 1);

const NOT_CONFIGURED = { status: 503, body: { error: "not_configured" } };
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
    const store = memoryStore();
    const deps: CreateSessionDeps = {
      store,
      rateLimit: allow,
      issuer: () => issuer,
      mm: () => mm,
      fundAccount: async (publicKey) => {
        funded.push(publicKey);
        return true;
      },
      ensureMmOffer: async () => {},
      encrypt: (plaintext) => {
        encrypted.push(plaintext);
        return encrypt(plaintext);
      },
      ...overrides,
    };
    return { deps, store, encrypted, funded };
  }

  const create = (deps: CreateSessionDeps, body?: unknown) =>
    handleCreateSession(
      request("/api/session", { body: body === undefined ? undefined : JSON.stringify(body) }),
      deps
    );

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
      demolishDone: false,
      fundRareAssets: ["AIRDROP1", "RUGPULL"],
      offerCount: 3,
      dataEntryCount: 3,
    });
    expect(decrypt(stored!.encDemoSecret)).toBe(encrypted[0]!);
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

  test("a missing issuer or market maker key is not_configured, before Friendbot", async () => {
    for (const missing of [{ issuer: () => null }, { mm: () => null }]) {
      const { deps, funded } = createDeps(missing);
      expect(await outcome(await create(deps, { mode: "light" }))).toEqual(NOT_CONFIGURED);
      expect(funded).toEqual([]);
    }
  });

  test("a Friendbot failure is friendbot_failed and stores nothing", async () => {
    const { deps, store } = createDeps({ fundAccount: async () => false });
    const counted = countingStore(store);
    const res = await create({ ...deps, store: counted.store }, { mode: "light" });
    expect(await outcome(res)).toEqual({ status: 502, body: { error: "friendbot_failed" } });
    expect(counted.calls()).toBe(0);
  });

  test("a failed market maker offer refresh does not fail the session", async () => {
    const { deps } = createDeps({
      ensureMmOffer: async () => {
        throw new Error("horizon unavailable");
      },
    });
    expect((await create(deps, { mode: "light" })).status).toBe(200);
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
      expect((await store.loadSession(body.sessionId as string))?.offerCount).toBe(3);
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
    expect(await store.loadSession(body.sessionId as string)).toMatchObject({
      offerCount: 5,
      dataEntryCount: 0,
      fundRareAssets: ["AIRDROP1", "RUGPULL"],
    });
  });
});

describe("parseCreateBody", () => {
  test("only the four known modes are accepted", () => {
    expect(parseCreateBody({ mode: "light" }).mode).toBe("light");
    expect(parseCreateBody({ mode: "full" }).mode).toBe("full");
    expect(parseCreateBody({ mode: "LIGHT" }).mode).toBe("standard");
    expect(parseCreateBody({ mode: 1 }).mode).toBe("standard");
    expect(parseCreateBody(null)).toEqual({
      mode: "standard",
      customConfig: DEFAULT_CUSTOM_CONFIG,
    });
  });

  test("a custom config is read only in custom mode", () => {
    const custom = { trustlineCount: 4, offerCount: 3, dataEntryCount: 1, addSigner: true };
    expect(parseCreateBody({ mode: "light", customConfig: custom }).customConfig).toEqual(
      DEFAULT_CUSTOM_CONFIG
    );
    expect(parseCreateBody({ mode: "custom", customConfig: custom }).customConfig).toEqual(custom);
    expect(parseCreateBody({ mode: "custom" }).customConfig).toEqual(DEFAULT_CUSTOM_CONFIG);
  });

  test("missing custom fields take defaults, and the offer default respects the trustlines", () => {
    expect(
      parseCreateBody({ mode: "custom", customConfig: { trustlineCount: 1 } }).customConfig
    ).toEqual({ trustlineCount: 1, offerCount: 1, dataEntryCount: 2, addSigner: false });
    expect(
      parseCreateBody({ mode: "custom", customConfig: { trustlineCount: 0, offerCount: 3 } })
        .customConfig
    ).toMatchObject({ trustlineCount: 1, offerCount: 1 });
  });
});

// ─── POST /api/session/[id]/mess ───────────────────────────────────────────────

describe("mess step", () => {
  const issuer = Keypair.random();
  const mm = Keypair.random();

  function messDeps(store: SessionStore, executed: [MessStepId, MessContext][] = []) {
    return {
      store,
      issuer: () => issuer,
      mm: () => mm,
      decrypt,
      executeMessStep: async (stepId: MessStepId, ctx: MessContext) => {
        executed.push([stepId, ctx]);
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

  test("a step runs with the session's keys and counts and is recorded", async () => {
    const store = memoryStore();
    const seeded = await seed(store, { offerCount: 2, dataEntryCount: 1 });
    const executed: [MessStepId, MessContext][] = [];
    const res = await step(seeded.id, { stepId: "OFFERS" }, messDeps(store, executed));

    expect(await outcome(res)).toEqual({
      status: 200,
      body: { stepId: "OFFERS", txHash: "a".repeat(64) },
    });
    expect(executed).toHaveLength(1);
    const [stepId, ctx] = executed[0]!;
    expect(stepId).toBe("OFFERS");
    expect(ctx.demo.publicKey()).toBe(seeded.demo.publicKey());
    expect(ctx.ephemeralIssuers.get("RUGPULL")?.publicKey()).toBe(
      seeded.issuers.get("RUGPULL")!.publicKey()
    );
    expect(ctx.persistentIssuer.publicKey()).toBe(issuer.publicKey());
    expect(ctx.mmPublic).toBe(mm.publicKey());
    expect([ctx.offerCount, ctx.dataEntryCount]).toEqual([2, 1]);
    expect(ctx.fundRareAssets).toEqual(["AIRDROP1", "RUGPULL"]);
    expect((await store.loadSession(seeded.id))?.completedMessSteps).toEqual(["OFFERS"]);
  });

  test("a signer the step records is persisted on the session", async () => {
    const store = memoryStore();
    const seeded = await seed(store);
    const signer = Keypair.random().publicKey();
    const res = await step(
      seeded.id,
      { stepId: "ADD_SIGNER" },
      {
        ...messDeps(store),
        executeMessStep: async (_stepId, ctx) => {
          await ctx.recordSigner(signer);
          return "b".repeat(64);
        },
      }
    );
    expect(res.status).toBe(200);
    expect((await store.loadSession(seeded.id))?.recordedSigners).toEqual([signer]);
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
    const executed: [MessStepId, MessContext][] = [];
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

// ─── POST /api/session/[id]/demolish ───────────────────────────────────────────

describe("demolish", () => {
  const issuer = Keypair.random();
  const mm = Keypair.random();
  const api = { apiUrl: "http://localhost:3001", apiKey: "test-api-key" };

  function demolishDeps(store: SessionStore, runs: RunDemolishOptions[] = []) {
    return {
      store,
      issuer: () => issuer,
      mm: () => mm,
      api: () => api,
      decrypt,
      runDemolish: async (opts: RunDemolishOptions) => {
        runs.push(opts);
        opts.onConfirmed?.("tx-1", "c".repeat(64), "Close the account", []);
      },
    };
  }

  test("the close runs against the session record and marks the session done", async () => {
    const store = memoryStore();
    const signer = Keypair.random().publicKey();
    const seeded = await seed(store, { recordedSigners: [signer] });
    const runs: RunDemolishOptions[] = [];
    const res = await handleDemolish(seeded.id, demolishDeps(store, runs));

    expect(await outcome(res)).toEqual({ status: 200, body: { done: true } });
    expect(runs).toHaveLength(1);
    const opts = runs[0]!;
    expect(opts.demoKeypair.publicKey()).toBe(seeded.demo.publicKey());
    expect([opts.apiUrl, opts.apiKey]).toEqual([api.apiUrl, api.apiKey]);
    expect(opts.expected).toMatchObject({
      demoPublic: seeded.demo.publicKey(),
      sinkPublic: mm.publicKey(),
      recordedSigners: [signer],
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
    expect(await outcome(await handleDemolish(seeded.id, demolishDeps(store, runs)))).toEqual({
      status: 200,
      body: { done: true },
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
      expect(await outcome(await handleDemolish(seeded.id, deps))).toEqual(NOT_CONFIGURED);
    }
    expect(counted.calls()).toBe(0);
  });

  test("an unknown or expired session is session_not_found", async () => {
    const clock = fakeClock();
    const store = memoryStore(clock);
    const seeded = await seed(store);
    expect(await outcome(await handleDemolish(NOT_A_UUID, demolishDeps(store)))).toEqual(NOT_FOUND);
    expired(clock);
    expect(await outcome(await handleDemolish(seeded.id, demolishDeps(store)))).toEqual(NOT_FOUND);
  });

  test("a failed close is demolish_failed and leaves the session not done", async () => {
    const store = memoryStore();
    const seeded = await seed(store);
    const res = await handleDemolish(seeded.id, {
      ...demolishDeps(store),
      runDemolish: async () => {
        throw new Error("verification refused");
      },
    });
    expect(await outcome(res)).toEqual({ status: 502, body: { error: "demolish_failed" } });
    expect((await store.loadSession(seeded.id))?.demolishDone).toBe(false);
  });
});

// ─── POST /api/session/[id]/cleanup ────────────────────────────────────────────

describe("cleanup", () => {
  const mm = Keypair.random();

  test("every ephemeral issuer is merged into the market maker and the session deleted", async () => {
    const store = memoryStore();
    const seeded = await seed(store);
    const merges: [string, string][] = [];
    const res = await handleCleanup(seeded.id, {
      store,
      mm: () => mm,
      decrypt,
      merge: async (source, destination) => {
        merges.push([source.publicKey(), destination]);
      },
    });
    const issuers = [...seeded.issuers.values()].map((kp) => kp.publicKey());
    expect(await outcome(res)).toEqual({ status: 200, body: { ok: true, recycled: issuers } });
    expect(merges).toEqual(issuers.map((pub) => [pub, mm.publicKey()]));
    expect(await store.loadSession(seeded.id)).toBeNull();
  });

  test("a failed merge is skipped and the others still run", async () => {
    const store = memoryStore();
    const seeded = await seed(store);
    const rugpull = seeded.issuers.get("RUGPULL")!.publicKey();
    const res = await handleCleanup(seeded.id, {
      store,
      mm: () => mm,
      decrypt,
      merge: async (source) => {
        if (source.publicKey() !== rugpull) throw new Error("op_has_sub_entries");
      },
    });
    expect(await outcome(res)).toEqual({ status: 200, body: { ok: true, recycled: [rugpull] } });
  });

  test("with no market maker key nothing is merged and the session is still deleted", async () => {
    const store = memoryStore();
    const seeded = await seed(store);
    let merges = 0;
    const res = await handleCleanup(seeded.id, {
      store,
      mm: () => null,
      decrypt,
      merge: async () => {
        merges++;
      },
    });
    expect(await outcome(res)).toEqual({ status: 200, body: { ok: true, recycled: [] } });
    expect(merges).toBe(0);
    expect(await store.loadSession(seeded.id)).toBeNull();
  });

  test("an unknown session is session_not_found", async () => {
    const deps = { store: memoryStore(), mm: () => mm, decrypt, merge: async () => {} };
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
