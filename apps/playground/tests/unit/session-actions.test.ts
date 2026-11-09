import { test, expect, describe } from "bun:test";
import { CloseOutcomeUnknownError, LumenWipeApiError } from "@lumenwipe/sdk";
import { PlaygroundConfigError } from "@/lib/crypto";
import type { DemolishRoundResult } from "@/lib/demolish";
import { readSessionState, runCleanup, runDemolishRound, runMessStep } from "@/lib/session-actions";
import type { DemolishLogEntry, PendingDemolishTx, SessionStore } from "@/lib/session-store";
import type { MessStepDef } from "@/lib/scenarios";
import { gate, memoryStore, newSessionData, tick } from "./session-fixtures";

const UNKNOWN_ID = "6f1c2a4e-3b5d-4c7e-9a8b-1d2e3f4a5b6c";

const outcome = (r: { body: Record<string, unknown> }): string =>
  typeof r.body.error === "string" ? r.body.error : "ok";

/** A session that selected only the forgotten signer, with its setup step already done. */
const signerSessionData = () => ({
  ...newSessionData(),
  selection: { scenarios: [{ id: "forgotten-signer" as const, params: {} }] },
  completedMessSteps: ["SETUP"],
});

const DONE: DemolishRoundResult = { done: true, remainingSteps: 0 };

const entry = (n: number): DemolishLogEntry => ({
  txId: `tx-${n}`,
  hash: String(n).repeat(64),
  summary: `transaction ${n}`,
  operations: [],
});

const pending = (n: number, closesAccount = false): PendingDemolishTx => ({
  ...entry(n),
  validUntil: 1_800_000_100,
  closesAccount,
});

test("two simultaneous requests for the same mess step execute it once", async () => {
  const store = memoryStore();
  const session = await store.createSession(newSessionData());
  const release = gate();
  let executions = 0;
  const executeStep = async (): Promise<string> => {
    executions++;
    await release.wait;
    return "hash";
  };

  const first = runMessStep(store, session.id, "SETUP", { executeStep });
  const second = runMessStep(store, session.id, "SETUP", { executeStep });
  await tick();
  release.open();
  const results = await Promise.all([first, second]);

  expect(executions).toBe(1);
  expect(results.map(outcome).sort()).toEqual(["ok", "step_in_progress"]);
  expect(results.find((r) => outcome(r) === "step_in_progress")?.status).toBe(409);
  expect((await store.loadSession(session.id))?.completedMessSteps).toEqual(["SETUP"]);
});

test("a request that read the session before another finished does not run the step again", async () => {
  const store = memoryStore();
  const session = await store.createSession(newSessionData());
  const resume = gate();
  let pausedOnce = false;
  const pausingStore: SessionStore = {
    ...store,
    async loadSession(id) {
      const loaded = await store.loadSession(id);
      if (!pausedOnce) {
        pausedOnce = true;
        await resume.wait;
      }
      return loaded;
    },
  };
  let executions = 0;
  const executeStep = async (): Promise<string> => {
    executions++;
    return "hash";
  };

  const late = runMessStep(pausingStore, session.id, "SETUP", { executeStep });
  await tick();
  const early = await runMessStep(store, session.id, "SETUP", { executeStep });
  resume.open();
  const lateResult = await late;

  expect(outcome(early)).toBe("ok");
  expect(outcome(lateResult)).toBe("step_already_executed");
  expect(executions).toBe(1);
});

test("two different mess steps on one session do not run at the same time", async () => {
  const store = memoryStore();
  const session = await store.createSession(newSessionData());
  const release = gate();
  const executed: string[] = [];
  const executeStep = async (step: MessStepDef): Promise<string> => {
    executed.push(step.id);
    await release.wait;
    return "hash";
  };

  const first = runMessStep(store, session.id, "SETUP", { executeStep });
  const second = runMessStep(store, session.id, "TRUST_LWDEMO", { executeStep });
  await tick();
  release.open();
  const results = await Promise.all([first, second]);

  expect(executed).toEqual(["SETUP"]);
  expect(results.map(outcome).sort()).toEqual(["ok", "step_in_progress"]);
});

test("two simultaneous demolish rounds on one session run once", async () => {
  const store = memoryStore();
  const session = await store.createSession(newSessionData());
  const release = gate();
  let rounds = 0;
  const round = async (): Promise<DemolishRoundResult> => {
    rounds++;
    await release.wait;
    return DONE;
  };

  const first = runDemolishRound(store, session.id, { round });
  const second = runDemolishRound(store, session.id, { round });
  await tick();
  release.open();
  const results = await Promise.all([first, second]);

  expect(rounds).toBe(1);
  expect(results.map(outcome).sort()).toEqual(["ok", "step_in_progress"]);
  expect((await store.loadSession(session.id))?.demolishDone).toBe(true);
});

test("a demolish round while a mess step is in flight is refused", async () => {
  const store = memoryStore();
  const session = await store.createSession(newSessionData());
  const release = gate();
  let rounds = 0;

  const mess = runMessStep(store, session.id, "SETUP", {
    executeStep: async () => {
      await release.wait;
      return "hash";
    },
  });
  await tick();
  const demolish = await runDemolishRound(store, session.id, {
    round: async () => {
      rounds++;
      return DONE;
    },
  });
  release.open();
  await mess;

  expect(outcome(demolish)).toBe("step_in_progress");
  expect(rounds).toBe(0);
});

test("log updates from callbacks fired together are all kept, in order", async () => {
  const store = memoryStore();
  const session = await store.createSession(newSessionData());

  const result = await runDemolishRound(store, session.id, {
    round: async (_session, hooks) => {
      await hooks.persistPending(pending(1));
      for (let n = 1; n <= 5; n++) hooks.onConfirmed(entry(n), n === 5);
      return DONE;
    },
  });

  expect(result.body.confirmed).toEqual([1, 2, 3, 4, 5].map(entry));
  const loaded = await store.loadSession(session.id);
  expect(loaded?.demolishLog.map((e) => e.txId)).toEqual(["tx-1", "tx-2", "tx-3", "tx-4", "tx-5"]);
  expect(loaded?.demolishPending).toBeNull();
  expect(loaded?.demolishDone).toBe(true);
});

test("a round that is not the last leaves the session open and reports what is left", async () => {
  const store = memoryStore();
  const session = await store.createSession(newSessionData());

  const result = await runDemolishRound(store, session.id, {
    round: async (_session, hooks) => {
      hooks.onConfirmed(entry(1), false);
      return { done: false, remainingSteps: 2 };
    },
  });

  expect(result).toEqual({
    status: 200,
    body: { done: false, confirmed: [entry(1)], remainingSteps: 2 },
  });
  expect((await store.loadSession(session.id))?.demolishDone).toBe(false);
});

test("a round that fails midway resumes with only what it had not confirmed", async () => {
  const store = memoryStore();
  const session = await store.createSession(newSessionData());
  // The API is stateless: each round builds from the account as it now is, so a confirmed
  // transaction is never handed out again. This fake plays that account.
  const onChain = new Set<number>();
  const batch = [1, 2, 3];
  let failNext = true;
  const round = async (
    _s: unknown,
    hooks: Parameters<Parameters<typeof runDemolishRound>[2]["round"]>[1]
  ): Promise<DemolishRoundResult> => {
    for (const n of batch.filter((b) => !onChain.has(b))) {
      if (n === 2 && failNext) {
        failNext = false;
        throw new Error("tx_bad_seq");
      }
      await hooks.persistPending(pending(n, n === 3));
      onChain.add(n);
      hooks.settled();
      hooks.onConfirmed(entry(n), n === 3);
    }
    return DONE;
  };

  const failed = await runDemolishRound(store, session.id, { round });
  expect(failed).toEqual({ status: 502, body: { error: "demolish_failed" } });
  expect((await store.loadSession(session.id))?.demolishLog).toEqual([entry(1)]);

  const resumed = await runDemolishRound(store, session.id, { round });
  expect(resumed.body).toEqual({ done: true, confirmed: [entry(2), entry(3)], remainingSteps: 0 });
  const loaded = await store.loadSession(session.id);
  expect(loaded?.demolishLog).toEqual([entry(1), entry(2), entry(3)]);
  expect(loaded?.demolishPending).toBeNull();
});

test("a transaction in flight is recorded before it is sent and handed to the next round", async () => {
  const store = memoryStore();
  const session = await store.createSession(newSessionData());
  const seen: (PendingDemolishTx | null)[] = [];

  const unknown = await runDemolishRound(store, session.id, {
    round: async (_session, hooks) => {
      seen.push(hooks.pending);
      await hooks.persistPending(pending(1, true));
      throw new CloseOutcomeUnknownError({ hash: entry(1).hash, covers: ["MERGE"], validUntil: 0 });
    },
  });
  expect(unknown).toEqual({ status: 502, body: { error: "demolish_outcome_unknown" } });
  expect((await store.loadSession(session.id))?.demolishPending).toEqual(pending(1, true));

  await runDemolishRound(store, session.id, {
    round: async (_session, hooks) => {
      seen.push(hooks.pending);
      hooks.settled();
      hooks.onConfirmed(entry(1), true);
      return DONE;
    },
  });
  expect(seen).toEqual([null, pending(1, true)]);
  const loaded = await store.loadSession(session.id);
  expect(loaded?.demolishLog).toEqual([entry(1)]);
  expect(loaded?.demolishPending).toBeNull();
  expect(loaded?.demolishDone).toBe(true);
});

test("a transaction that settles without confirming has its record cleared", async () => {
  const store = memoryStore();
  const session = await store.createSession(newSessionData());

  const result = await runDemolishRound(store, session.id, {
    round: async (_session, hooks) => {
      await hooks.persistPending(pending(1));
      hooks.settled();
      throw new Error("tx_failed");
    },
  });
  expect(outcome(result)).toBe("demolish_failed");
  const loaded = await store.loadSession(session.id);
  expect(loaded?.demolishPending).toBeNull();
  expect(loaded?.demolishLog).toEqual([]);
});

/** A store whose next write that appends to the demolish log fails, once. */
function failingLogWriteOnce(store: SessionStore): SessionStore {
  let armed = true;
  return {
    ...store,
    updateSession: async (lock, patch) => {
      const current = await store.loadSession(lock.sessionId);
      if (armed && current && patch(current).demolishLog) {
        armed = false;
        throw new Error("store unavailable");
      }
      return store.updateSession(lock, patch);
    },
  };
}

// The engine reports a settlement before the confirmation today; both orders are held here, so a
// change in the engine cannot make the round drop a record whose log write failed.
const ORDERS = ["settled, then confirmed", "confirmed, then settled"] as const;
type Hooks = Parameters<Parameters<typeof runDemolishRound>[2]["round"]>[1];
function settleAndConfirm(
  hooks: Hooks,
  order: (typeof ORDERS)[number],
  logged: DemolishLogEntry,
  closesAccount: boolean
): void {
  if (order === ORDERS[0]) hooks.settled();
  hooks.onConfirmed(logged, closesAccount);
  if (order === ORDERS[1]) hooks.settled();
}

describe("a confirmation whose log write failed keeps its record for the next round", () => {
  for (const order of ORDERS) {
    test(`a transaction that does not close the account (${order})`, async () => {
      const store = memoryStore();
      const session = await store.createSession(newSessionData());

      const first = await runDemolishRound(failingLogWriteOnce(store), session.id, {
        round: async (_session, hooks) => {
          await hooks.persistPending(pending(1));
          settleAndConfirm(hooks, order, entry(1), false);
          return { done: false, remainingSteps: 1 };
        },
      });
      expect(first.body).toEqual({ done: false, confirmed: [], remainingSteps: 1 });
      const afterFirst = await store.loadSession(session.id);
      expect(afterFirst?.demolishPending).toEqual(pending(1));
      expect(afterFirst?.demolishLog).toEqual([]);

      // The next round's lookup finds the transaction confirmed and reports it from the record.
      const second = await runDemolishRound(store, session.id, {
        round: async (_session, hooks) => {
          expect(hooks.pending).toEqual(pending(1));
          settleAndConfirm(hooks, order, entry(1), false);
          return { done: false, remainingSteps: 1 };
        },
      });
      expect(second.body).toEqual({ done: false, confirmed: [entry(1)], remainingSteps: 1 });
      const afterSecond = await store.loadSession(session.id);
      expect(afterSecond?.demolishLog).toEqual([entry(1)]);
      expect(afterSecond?.demolishPending).toBeNull();
    });

    test(`the merge (${order})`, async () => {
      const store = memoryStore();
      const session = await store.createSession(newSessionData());

      const result = await runDemolishRound(failingLogWriteOnce(store), session.id, {
        round: async (_session, hooks) => {
          await hooks.persistPending(pending(1, true));
          settleAndConfirm(hooks, order, entry(1), true);
          return DONE;
        },
      });

      expect(result.body).toEqual({ done: true, confirmed: [entry(1)], remainingSteps: 0 });
      const loaded = await store.loadSession(session.id);
      expect(loaded?.demolishLog).toEqual([entry(1)]);
      expect(loaded?.demolishPending).toBeNull();
      expect(loaded?.demolishDone).toBe(true);
    });
  }
});

test("a record that cannot be written stops the round before anything is sent", async () => {
  const store = memoryStore();
  const session = await store.createSession(newSessionData());
  let sent = 0;
  const lockLosing: SessionStore = {
    ...store,
    updateSession: async () => {
      throw new Error("lock lost");
    },
  };

  const result = await runDemolishRound(lockLosing, session.id, {
    round: async (_session, hooks) => {
      await hooks.persistPending(pending(1));
      sent++;
      return DONE;
    },
  });
  expect(outcome(result)).toBe("demolish_failed");
  expect(sent).toBe(0);
});

test("a session already demolished answers done without another round", async () => {
  const store = memoryStore();
  const session = await store.createSession({ ...newSessionData(), demolishDone: true });
  let rounds = 0;
  const result = await runDemolishRound(store, session.id, {
    round: async () => {
      rounds++;
      return DONE;
    },
  });
  expect(result.body).toEqual({ done: true, confirmed: [], remainingSteps: 0 });
  expect(rounds).toBe(0);
});

describe("the mess is frozen once the close has started", () => {
  const cases: [string, Partial<ReturnType<typeof newSessionData>>][] = [
    ["a confirmed transaction", { demolishLog: [entry(1)] }],
    ["a transaction in flight", { demolishPending: pending(1) }],
    ["a finished close", { demolishDone: true }],
  ];
  for (const [name, patch] of cases) {
    test(name, async () => {
      const store = memoryStore();
      const session = await store.createSession({ ...newSessionData(), ...patch });
      let executions = 0;
      const result = await runMessStep(store, session.id, "SETUP", {
        executeStep: async () => {
          executions++;
          return "hash";
        },
      });
      expect(result).toEqual({ status: 409, body: { error: "demolish_started" } });
      expect(executions).toBe(0);
    });
  }

  test("a round that failed before confirming anything leaves the mess open", async () => {
    const store = memoryStore();
    const session = await store.createSession(newSessionData());
    await runDemolishRound(store, session.id, {
      round: async () => {
        throw new Error("needs_decisions");
      },
    });
    const result = await runMessStep(store, session.id, "SETUP", {
      executeStep: async () => "hash",
    });
    expect(outcome(result)).toBe("ok");
  });
});

test("the lock is released after a failed step, so a retry can run", async () => {
  const store = memoryStore();
  const session = await store.createSession(newSessionData());
  let attempts = 0;
  const executeStep = async (): Promise<string> => {
    attempts++;
    if (attempts === 1) throw new Error("tx_bad_seq");
    return "hash";
  };

  const failed = await runMessStep(store, session.id, "SETUP", { executeStep });
  const retried = await runMessStep(store, session.id, "SETUP", { executeStep });

  expect(failed.status).toBe(502);
  expect(outcome(retried)).toBe("ok");
});

test("signers the step records are kept in the session, alongside the completed step", async () => {
  const store = memoryStore();
  const session = await store.createSession(signerSessionData());
  const result = await runMessStep(store, session.id, "ADD_SIGNER", {
    executeStep: async (_step, _session, recordSigner) => {
      await recordSigner("GSIGNER1");
      await recordSigner("GSIGNER2");
      return "hash";
    },
  });
  expect(outcome(result)).toBe("ok");
  const stored = await store.loadSession(session.id);
  expect(stored?.recordedSigners).toEqual(["GSIGNER1", "GSIGNER2"]);
  expect(stored?.completedMessSteps).toEqual(["SETUP", "ADD_SIGNER"]);
});

test("a signer recorded before its transaction failed stays recorded", async () => {
  const store = memoryStore();
  const session = await store.createSession(signerSessionData());
  const result = await runMessStep(store, session.id, "ADD_SIGNER", {
    executeStep: async (_step, _session, recordSigner) => {
      await recordSigner("GSIGNER");
      throw new Error("timeout after send");
    },
  });
  expect(result.status).toBe(502);
  const stored = await store.loadSession(session.id);
  expect(stored?.recordedSigners).toEqual(["GSIGNER"]);
  expect(stored?.completedMessSteps).toEqual(["SETUP"]);
});

test("an unknown session is a 404 and takes no lock", async () => {
  const store = memoryStore();
  const result = await runMessStep(store, UNKNOWN_ID, "SETUP", {
    executeStep: async () => "hash",
  });
  expect(result.status).toBe(404);
  expect(await store.acquireLock(UNKNOWN_ID)).not.toBeNull();
});

test("cleanup is refused while a step holds the session", async () => {
  const store = memoryStore();
  const session = await store.createSession(newSessionData());
  const release = gate();
  let recycles = 0;

  const mess = runMessStep(store, session.id, "SETUP", {
    executeStep: async () => {
      await release.wait;
      return "hash";
    },
  });
  await tick();
  const cleanup = await runCleanup(store, session.id, {
    recycle: async () => {
      recycles++;
      return [];
    },
  });
  release.open();
  await mess;

  expect(outcome(cleanup)).toBe("step_in_progress");
  expect(recycles).toBe(0);
  expect(await store.loadSession(session.id)).not.toBeNull();
});

describe("failure responses carry a code and no upstream text", () => {
  const UPSTREAM = "op_underfunded from horizon-testnet.stellar.org request 7f3a";
  const leaks = (r: { body: Record<string, unknown> }): boolean =>
    JSON.stringify(r.body).includes("op_underfunded") || JSON.stringify(r.body).includes("7f3a");

  test("a failed mess step", async () => {
    const store = memoryStore();
    const session = await store.createSession(newSessionData());
    const result = await runMessStep(store, session.id, "SETUP", {
      executeStep: async () => {
        throw new Error(UPSTREAM);
      },
    });
    expect(result).toEqual({ status: 502, body: { error: "tx_failed" } });
    expect(leaks(result)).toBe(false);
  });

  test("a failed demolish", async () => {
    const store = memoryStore();
    const session = await store.createSession(newSessionData());
    const result = await runDemolishRound(store, session.id, {
      round: async () => {
        throw new Error(UPSTREAM);
      },
    });
    expect(result).toEqual({ status: 502, body: { error: "demolish_failed" } });
    expect(leaks(result)).toBe(false);
  });

  test("a failed account state read", async () => {
    const store = memoryStore();
    const session = await store.createSession(newSessionData());
    const result = await readSessionState(session, {
      getAccount: async () => {
        throw new LumenWipeApiError(500, { error: { code: "internal", message: UPSTREAM } });
      },
    });
    expect(result).toEqual({ status: 502, body: { error: "state_read_failed" } });
    expect(leaks(result)).toBe(false);
  });

  test("a missing server key is a not_configured code", async () => {
    const store = memoryStore();
    const session = await store.createSession(newSessionData());
    const result = await runMessStep(store, session.id, "SETUP", {
      executeStep: async () => {
        throw new PlaygroundConfigError(UPSTREAM);
      },
    });
    expect(result).toEqual({ status: 503, body: { error: "not_configured" } });
  });

  test("an account the API no longer finds is the merged-away success, not a failure", async () => {
    const store = memoryStore();
    const session = await store.createSession(newSessionData());
    const result = await readSessionState(session, {
      getAccount: async () => {
        throw new LumenWipeApiError(404, { error: { code: "not_found", message: UPSTREAM } });
      },
    });
    expect(result.status).toBe(200);
    expect(result.body.accountState).toBeNull();
    expect(leaks(result)).toBe(false);
  });
});

test("a store failure during cleanup is a cleanup_failed code, not a bare 500", async () => {
  const store = memoryStore();
  const session = await store.createSession(newSessionData());
  const failingStore: SessionStore = {
    ...store,
    deleteSession: async () => {
      throw new Error("ECONNRESET upstash.example 7f3a");
    },
  };
  const result = await runCleanup(failingStore, session.id, { recycle: async () => [] });
  expect(result).toEqual({ status: 502, body: { error: "cleanup_failed" } });
});

test("an id that is not a session uuid is a 404 and never reaches the store or the log", async () => {
  const store = memoryStore();
  let storeCalls = 0;
  const counted =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      storeCalls++;
      return fn(...args);
    };
  const watchedStore: SessionStore = {
    createSession: counted(store.createSession),
    loadSession: counted(store.loadSession),
    acquireLock: counted(store.acquireLock),
    releaseLock: counted(store.releaseLock),
    updateSession: counted(store.updateSession),
    deleteSession: counted(store.deleteSession),
  };
  const logged: unknown[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => void logged.push(args);
  const notFound = { status: 404, body: { error: "session_not_found" } };
  try {
    for (const id of ["%s%s%s", "abc\n[playground] forged line", "../../etc/passwd", ""]) {
      expect(
        await runMessStep(watchedStore, id, "SETUP", {
          executeStep: async () => {
            throw new Error("must not run");
          },
        })
      ).toEqual(notFound);
      expect(
        await runDemolishRound(watchedStore, id, {
          round: async () => {
            throw new Error("must not run");
          },
        })
      ).toEqual(notFound);
      expect(await runCleanup(watchedStore, id, { recycle: async () => [] })).toEqual(notFound);
    }
  } finally {
    console.error = originalError;
  }
  expect(storeCalls).toBe(0);
  expect(logged).toEqual([]);
});

describe("the session's own plan decides which step may run", () => {
  test("a light session refuses steps it did not select, and nothing runs", async () => {
    const store = memoryStore();
    const session = await store.createSession(newSessionData());
    const executed: string[] = [];
    for (const stepId of ["ADD_SIGNER", "TRUST_USDC", "OFFERS", "FUND_RARE"] as const) {
      const result = await runMessStep(store, session.id, stepId, {
        executeStep: async (step) => {
          executed.push(step.id);
          return "hash";
        },
      });
      expect({ stepId, result }).toEqual({
        stepId,
        result: { status: 400, body: { error: "step_not_in_plan" } },
      });
    }
    expect(executed).toEqual([]);
    const stored = await store.loadSession(session.id);
    expect(stored?.recordedSigners).toEqual([]);
    expect(stored?.completedMessSteps).toEqual([]);
  });

  test("a step runs only when every step before it in the plan is done", async () => {
    const store = memoryStore();
    const session = await store.createSession(newSessionData());
    const executed: string[] = [];
    const executeStep = async (step: MessStepDef): Promise<string> => {
      executed.push(step.id);
      return "hash";
    };
    expect(await runMessStep(store, session.id, "FUND_LWDEMO", { executeStep })).toEqual({
      status: 409,
      body: { error: "step_out_of_order" },
    });
    expect(await runMessStep(store, session.id, "TRUST_LWDEMO", { executeStep })).toEqual({
      status: 409,
      body: { error: "step_out_of_order" },
    });
    for (const stepId of ["SETUP", "TRUST_LWDEMO", "FUND_LWDEMO"] as const) {
      expect(outcome(await runMessStep(store, session.id, stepId, { executeStep }))).toBe("ok");
    }
    expect(executed).toEqual(["SETUP", "TRUST_LWDEMO", "FUND_LWDEMO"]);
  });

  test("the executor receives the plan's own step, with its action", async () => {
    const store = memoryStore();
    const session = await store.createSession(newSessionData());
    const received: MessStepDef[] = [];
    await runMessStep(store, session.id, "SETUP", {
      executeStep: async (step) => {
        received.push(step);
        return "hash";
      },
    });
    expect(received.map((s) => [s.id, s.action.kind])).toEqual([["SETUP", "setup"]]);
  });
});
