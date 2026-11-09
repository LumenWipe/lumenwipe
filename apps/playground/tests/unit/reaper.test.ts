import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { Keypair } from "@stellar/stellar-sdk";
import { DemolishDecisionUnanswerableError, type DemolishRoundHooks } from "@/lib/demolish";
import { TxSubmitError } from "@/lib/horizon-submit";
import { selectionForMode } from "@/lib/mess-plan";
import {
  MAX_ROUNDS_PER_SESSION,
  REAP_AFTER_MS,
  runReaper,
  type ReaperDeps,
  type ReaperSummary,
} from "@/lib/reaper";
import { cleanupActionDeps, handleCreateSession, handleReap } from "@/lib/route-handlers";
import { PlaygroundVerificationError } from "@/lib/verify";
import {
  SESSION_RECORD_TTL_SECONDS,
  type NewSessionData,
  type PlaygroundSession,
  type SessionStore,
} from "@/lib/session-store";
import { fakeClock, memoryStore, newSessionData, type FakeClock } from "./session-fixtures";

// Fake store and fake network only. Every key is Keypair.random() per run, and the "encryption"
// is a reversible stand-in so the tests can see which secrets were decrypted and prove none of
// them, or their stored form, reaches a log line or the response.

const ENC = "enc:";
const encrypt = (plaintext: string): string => ENC + Buffer.from(plaintext).toString("base64");
// Generated per run: a cron secret the route accepts (32 hex characters).
const CRON_SECRET = randomBytes(16).toString("hex");

const mm = Keypair.random();
const issuer = Keypair.random();

interface Seeded {
  session: PlaygroundSession;
  demo: Keypair;
  issuers: Keypair[];
  secrets: string[];
}

async function seed(store: SessionStore, overrides: Partial<NewSessionData> = {}): Promise<Seeded> {
  const demo = Keypair.random();
  const issuers = [Keypair.random(), Keypair.random()];
  const session = await store.createSession({
    ...newSessionData(),
    demoPublic: demo.publicKey(),
    encDemoSecret: encrypt(demo.secret()),
    ephemeralIssuers: issuers.map((kp, i) => ({
      assetCode: ["AIRDROP1", "RUGPULL"][i]!,
      publicKey: kp.publicKey(),
      encSecret: encrypt(kp.secret()),
    })),
    selection: selectionForMode("standard"),
    ...overrides,
  });
  return { session, demo, issuers, secrets: [demo, ...issuers].map((kp) => kp.secret()) };
}

interface Network {
  /** Accounts the fake network holds. */
  live: Set<string>;
  merges: string[];
  rounds: { sessionId: string; pending: boolean }[];
  decrypted: string[];
  /** Accounts the fake Horizon was asked about. */
  checked: string[];
  topUps: number;
}

type RoundImpl = (
  session: PlaygroundSession,
  hooks: DemolishRoundHooks
) => Promise<{ done: boolean; remainingSteps: number | null }>;

/** A round that merges the demo in one transaction. */
const mergeRound =
  (net: Network): RoundImpl =>
  async (session, hooks) => {
    if (hooks.pending) hooks.settled();
    hooks.onConfirmed({ txId: "t1", hash: "f".repeat(64), summary: "merge", operations: [] }, true);
    net.live.delete(session.demoPublic);
    return { done: true, remainingSteps: 0 };
  };

function reaper(
  store: SessionStore,
  net: Network,
  overrides: Partial<ReaperDeps> & { roundImpl?: RoundImpl } = {}
): ReaperDeps {
  const decrypt = (payload: string): string => {
    const plain = Buffer.from(payload.slice(ENC.length), "base64").toString("utf8");
    net.decrypted.push(Keypair.fromSecret(plain).publicKey());
    return plain;
  };
  const roundImpl = overrides.roundImpl ?? mergeRound(net);
  const cleanup = cleanupActionDeps({
    mm: () => mm,
    issuer: () => issuer,
    decrypt,
    exists: async (publicKey) => {
      net.checked.push(publicKey);
      return net.live.has(publicKey);
    },
    merge: async (source) => {
      if (!net.live.has(source.publicKey())) throw new Error("tx_no_account");
      net.merges.push(source.publicKey());
      net.live.delete(source.publicKey());
    },
    submit: async () => "hash",
  })!;
  return {
    store,
    now: () => Date.now() + REAP_AFTER_MS + 1,
    round: {
      round: (session, hooks) => {
        net.rounds.push({ sessionId: session.id, pending: hooks.pending !== null });
        decrypt(session.encDemoSecret);
        return roundImpl(session, hooks);
      },
    },
    resolve: { resolve: async () => "hash" },
    cleanup,
    exists: async (publicKey) => {
      net.checked.push(publicKey);
      return net.live.has(publicKey);
    },
    verifiable: () => true,
    marketMakerBalance: async () => ({ balance: "9000.0000000", sellingLiabilities: "0" }),
    topUp: async () => {
      net.topUps++;
      return "funded";
    },
    refillLiquidity: async () => {},
    ...overrides,
  };
}

function network(...accounts: Keypair[]): Network {
  return {
    live: new Set(accounts.map((kp) => kp.publicKey())),
    merges: [],
    rounds: [],
    decrypted: [],
    checked: [],
    topUps: 0,
  };
}

const counts = (summary: ReaperSummary) => ({
  reaped: summary.reaped,
  kept: summary.kept,
  young: summary.young,
  pruned: summary.pruned,
});

let logged: string[] = [];
const originals = { error: console.error, warn: console.warn };
beforeEach(() => {
  logged = [];
  console.error = (...args: unknown[]) => void logged.push(JSON.stringify(args));
  console.warn = (...args: unknown[]) => void logged.push(JSON.stringify(args));
});
afterEach(() => {
  console.error = originals.error;
  console.warn = originals.warn;
});

/** No secret and no stored ciphertext in any log line. */
function expectNoSecretLogged(secrets: string[]): void {
  const text = logged.join("\n");
  expect(text).not.toContain(ENC);
  for (const secret of secrets) expect(text).not.toContain(secret);
}

describe("reaper", () => {
  test("an abandoned session past the threshold is closed, merged back and its record deleted", async () => {
    const store = memoryStore();
    const seeded = await seed(store);
    const net = network(seeded.demo, ...seeded.issuers);
    const summary = await runReaper(reaper(store, net));
    expect(counts(summary)).toEqual({ reaped: 1, kept: 0, young: 0, pruned: 0 });
    expect(net.rounds).toHaveLength(1);
    expect(net.merges).toEqual(seeded.issuers.map((kp) => kp.publicKey()));
    expect(net.live.size).toBe(0);
    expect(await store.loadSession(seeded.session.id)).toBeNull();
    expect(await store.indexedSessionIds()).toEqual([]);
    expectNoSecretLogged(seeded.secrets);
  });

  test("a session younger than the threshold is not touched", async () => {
    const store = memoryStore();
    const seeded = await seed(store);
    const net = network(seeded.demo, ...seeded.issuers);
    const deps = reaper(store, net, { now: () => seeded.session.createdAt + REAP_AFTER_MS - 1 });
    expect(counts(await runReaper(deps))).toEqual({ reaped: 0, kept: 0, young: 1, pruned: 0 });
    expect(net.rounds).toEqual([]);
    expect(net.decrypted).toEqual([]);
    expect(await store.loadSession(seeded.session.id)).not.toBeNull();
  });

  test("a session that finished its close gets no close round and its demo key is never used", async () => {
    const store = memoryStore();
    const seeded = await seed(store, { demolishDone: true });
    // Even with the demo reported live, a finished close is never run again.
    const net = network(seeded.demo, ...seeded.issuers);
    const summary = await runReaper(reaper(store, net));
    expect(summary.reaped).toBe(1);
    expect(net.rounds).toEqual([]);
    expect(net.merges).not.toContain(seeded.demo.publicKey());
    expect(net.checked).not.toContain(seeded.demo.publicKey());
    expect(net.decrypted).not.toContain(seeded.demo.publicKey());
    expect(net.merges).toEqual(seeded.issuers.map((kp) => kp.publicKey()));
    expect(await store.loadSession(seeded.session.id)).toBeNull();
  });

  test("a reap that fails part way keeps the record and the next run finishes it", async () => {
    const store = memoryStore();
    const seeded = await seed(store);
    const net = network(seeded.demo, ...seeded.issuers);
    const [flaky] = seeded.issuers;
    const first = reaper(store, net);
    const realMerge = first.cleanup;
    const failing = cleanupActionDeps({
      mm: () => mm,
      issuer: () => issuer,
      decrypt: (p) => Buffer.from(p.slice(ENC.length), "base64").toString("utf8"),
      exists: async (publicKey) => {
        net.checked.push(publicKey);
        return net.live.has(publicKey);
      },
      merge: async (source) => {
        if (source.publicKey() === flaky!.publicKey()) throw new Error("tx_bad_seq");
        net.merges.push(source.publicKey());
        net.live.delete(source.publicKey());
      },
      submit: async () => "hash",
    })!;
    expect(counts(await runReaper({ ...first, cleanup: failing }))).toEqual({
      reaped: 0,
      kept: 1,
      young: 0,
      pruned: 0,
    });
    const kept = await store.loadSession(seeded.session.id);
    expect(kept?.demolishDone).toBe(true);
    expect(kept?.ephemeralIssuers.map((e) => e.publicKey)).toEqual([flaky!.publicKey()]);

    expect(counts(await runReaper({ ...first, cleanup: realMerge }))).toEqual({
      reaped: 1,
      kept: 0,
      young: 0,
      pruned: 0,
    });
    expect(net.rounds).toHaveLength(1);
    expect(net.live.size).toBe(0);
    expect(await store.loadSession(seeded.session.id)).toBeNull();
  });

  test("a session whose lock is held is left alone for the next run", async () => {
    const store = memoryStore();
    const seeded = await seed(store);
    const net = network(seeded.demo, ...seeded.issuers);
    const held = await store.acquireLock(seeded.session.id);
    expect(held).not.toBeNull();
    expect(counts(await runReaper(reaper(store, net)))).toEqual({
      reaped: 0,
      kept: 1,
      young: 0,
      pruned: 0,
    });
    expect(net.rounds).toEqual([]);
    expect(net.merges).toEqual([]);
    expect(await store.loadSession(seeded.session.id)).not.toBeNull();
  });

  test("a close transaction left in flight is settled by the close before anything else", async () => {
    const store = memoryStore();
    const seeded = await seed(store, {
      demolishPending: {
        txId: "t1",
        hash: "e".repeat(64),
        summary: "merge",
        operations: [],
        validUntil: null,
        closesAccount: true,
      },
    });
    // The merge already landed: the demo is gone, but its record still says in flight.
    const net = network(...seeded.issuers);
    const summary = await runReaper(reaper(store, net));
    expect(net.rounds).toEqual([{ sessionId: seeded.session.id, pending: true }]);
    expect(summary.reaped).toBe(1);
    expect(net.merges).toEqual(seeded.issuers.map((kp) => kp.publicKey()));
  });

  test("a session whose plan cannot be verified gets no close, and the run moves on", async () => {
    const store = memoryStore();
    const seeded = await seed(store);
    const net = network(seeded.demo, ...seeded.issuers);
    const summary = await runReaper(reaper(store, net, { verifiable: () => false }));
    expect(counts(summary)).toEqual({ reaped: 0, kept: 1, young: 0, pruned: 0 });
    expect(net.rounds).toEqual([]);
    expect(net.decrypted).toEqual([]);
    expect(net.merges).toEqual([]);
    expect(logged.join("\n")).toContain(seeded.demo.publicKey());
    expectNoSecretLogged(seeded.secrets);
  });

  test("a verifier refusal or an unanswerable decision ends that session's work for the run", async () => {
    for (const error of [
      new PlaygroundVerificationError("operation_not_allowed"),
      new DemolishDecisionUnanswerableError(["destination:G..."]),
    ]) {
      const store = memoryStore();
      const seeded = await seed(store);
      const net = network(seeded.demo, ...seeded.issuers);
      const summary = await runReaper(
        reaper(store, net, {
          roundImpl: async () => {
            throw error;
          },
        })
      );
      expect(counts(summary)).toEqual({ reaped: 0, kept: 1, young: 0, pruned: 0 });
      expect(net.rounds).toHaveLength(1);
      expect(net.merges).toEqual([]);
      expect(await store.loadSession(seeded.session.id)).not.toBeNull();
      expectNoSecretLogged(seeded.secrets);
    }
  });

  test("a close that keeps going stops at the round cap", async () => {
    const store = memoryStore();
    const seeded = await seed(store);
    const net = network(seeded.demo, ...seeded.issuers);
    await runReaper(
      reaper(store, net, { roundImpl: async () => ({ done: false, remainingSteps: 3 }) })
    );
    expect(net.rounds).toHaveLength(MAX_ROUNDS_PER_SESSION);
    expect(await store.loadSession(seeded.session.id)).not.toBeNull();
  });

  test("an expired record is pruned from the index", async () => {
    const clock: FakeClock = fakeClock();
    const store = memoryStore(clock);
    const seeded = await seed(store);
    clock.advance(SESSION_RECORD_TTL_SECONDS * 1000 + 1);
    const net = network();
    expect(counts(await runReaper(reaper(store, net)))).toEqual({
      reaped: 0,
      kept: 0,
      young: 0,
      pruned: 1,
    });
    expect(await store.indexedSessionIds()).toEqual([]);
    expect(seeded.session.id).toBeTruthy();
  });

  test("a session whose rejected funding could not be deleted is resolved through the missing demo", async () => {
    const store = memoryStore();
    const failingDelete: SessionStore = {
      ...store,
      deleteSession: async () => {
        throw new Error("ECONNRESET");
      },
    };
    const res = await handleCreateSession(
      new NextRequest("http://localhost:3002/api/session", {
        method: "POST",
        body: JSON.stringify({ mode: "light" }),
      }),
      {
        store: failingDelete,
        rateLimit: async () => null,
        issuer: () => issuer,
        mm: () => mm,
        cronSecret: () => CRON_SECRET,
        marketMakerBalance: async () => ({ balance: "9000.0000000", sellingLiabilities: "0" }),
        provisionDemo: async () => {
          throw new TxSubmitError("rejected", "tx_insufficient_balance");
        },
        encrypt,
        unavailable: () => new Map(),
      }
    );
    expect(res.status).toBe(502);
    const [id] = await store.indexedSessionIds();
    expect(await store.loadSession(id!)).not.toBeNull();

    // Nothing was ever created on the network.
    const net = network();
    const summary = await runReaper(reaper(store, net));
    expect(counts(summary)).toEqual({ reaped: 1, kept: 0, young: 0, pruned: 0 });
    expect(net.rounds).toEqual([]);
    expect(net.merges).toEqual([]);
    expect(await store.indexedSessionIds()).toEqual([]);
  });

  test("a blocker the plan resolves is resolved once, then the close goes on; one that persists stops it", async () => {
    const { DemolishBlockedError } = await import("@/lib/demolish");
    for (const clears of [true, false]) {
      const store = memoryStore();
      const claimant = Keypair.random();
      const seeded = await seed(store, {
        selection: { scenarios: [{ id: "claimable-balances", params: { demo_sponsored: 1 } }] },
        completedMessSteps: ["CLAIMABLE_BALANCES"],
        helperAccounts: [
          {
            role: "claimant",
            publicKey: claimant.publicKey(),
            encSecret: encrypt(claimant.secret()),
          },
        ],
        claimableBalances: [
          { id: `00000000${"7".repeat(64)}`, asset: "native", intent: "demo_sponsored" },
        ],
      });
      const net = network(seeded.demo, ...seeded.issuers);
      let blocked = true;
      const resolved: string[] = [];
      const summary = await runReaper(
        reaper(store, net, {
          resolve: {
            resolve: async (_session, resolution) => {
              resolved.push(resolution.blocker);
              blocked = !clears;
              return "hash";
            },
          },
          roundImpl: async (session, hooks) => {
            if (blocked) {
              throw new DemolishBlockedError(["sponsorship_claimable_balance_unrevocable"]);
            }
            return mergeRound(net)(session, hooks);
          },
        })
      );
      expect(resolved).toEqual(["sponsorship_claimable_balance_unrevocable"]);
      expect(net.rounds).toHaveLength(2);
      expect(summary.reaped).toBe(clears ? 1 : 0);
      expect(summary.kept).toBe(clears ? 0 : 1);
    }
  });

  test("the market maker is topped up only below its threshold", async () => {
    const low = network();
    const lowSummary = await runReaper(
      reaper(memoryStore(), low, {
        marketMakerBalance: async () => ({ balance: "4000.0000000", sellingLiabilities: "0" }),
      })
    );
    expect(low.topUps).toBe(1);
    expect(lowSummary.topUp).toBe("funded");

    const high = network();
    const highSummary = await runReaper(reaper(memoryStore(), high));
    expect(high.topUps).toBe(0);
    expect(highSummary.topUp).toBe("not_needed");
  });

  test("a second delivery of the same run does nothing", async () => {
    const store = memoryStore();
    const seeded = await seed(store);
    const net = network(seeded.demo, ...seeded.issuers);
    const lease = await store.acquireLease("reaper", 60_000);
    expect(lease).not.toBeNull();
    const summary = await runReaper(reaper(store, net));
    expect(summary.skipped).toBe(true);
    expect(net.rounds).toEqual([]);
  });
});

describe("reaper route", () => {
  const request = (authorization?: string) =>
    new NextRequest("http://localhost:3002/api/cron/reap", {
      headers: authorization === undefined ? {} : { authorization },
    });

  test("a call without the cron secret is refused before any store, network or key use", async () => {
    let built = 0;
    const cases: [string | undefined, string | undefined][] = [
      [CRON_SECRET, undefined],
      [CRON_SECRET, "Bearer"],
      [CRON_SECRET, `Bearer ${CRON_SECRET}x`],
      [CRON_SECRET, CRON_SECRET],
      [undefined, "Bearer undefined"],
      ["", "Bearer "],
      ["short", "Bearer short"],
    ];
    for (const [secret, header] of cases) {
      const res = await handleReap(request(header), {
        cronSecret: () => secret,
        reaper: () => {
          built++;
          return null;
        },
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    expect(built).toBe(0);
  });

  test("with the cron secret the run's summary holds counts only", async () => {
    const store = memoryStore();
    const seeded = await seed(store);
    const net = network(seeded.demo, ...seeded.issuers);
    const res = await handleReap(request(`Bearer ${CRON_SECRET}`), {
      cronSecret: () => CRON_SECRET,
      reaper: () => reaper(store, net),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      skipped: false,
      reaped: 1,
      kept: 0,
      young: 0,
      pruned: 0,
      deferred: 0,
      topUp: "not_needed",
      liquidity: "ok",
    });
    expectNoSecretLogged(seeded.secrets);
  });

  test("a missing key or setting is not_configured once the secret checks out", async () => {
    const res = await handleReap(request(`Bearer ${CRON_SECRET}`), {
      cronSecret: () => CRON_SECRET,
      reaper: () => null,
    });
    expect(res.status).toBe(503);
  });
});
