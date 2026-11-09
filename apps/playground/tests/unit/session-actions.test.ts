import { test, expect, describe } from "bun:test";
import { LumenWipeApiError, type IntentOperation } from "@lumenwipe/sdk";
import { PlaygroundConfigError } from "@/lib/crypto";
import { readSessionState, runCleanup, runDemolishStep, runMessStep } from "@/lib/session-actions";
import type { SessionStore } from "@/lib/session-store";
import { gate, memoryStore, newSessionData, tick } from "./session-fixtures";

const outcome = (r: { body: Record<string, unknown> }): string =>
  typeof r.body.error === "string" ? r.body.error : "ok";

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
  const executeStep = async (stepId: string): Promise<string> => {
    executed.push(stepId);
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

test("two simultaneous demolish requests on one session run one close loop", async () => {
  const store = memoryStore();
  const session = await store.createSession(newSessionData());
  const release = gate();
  let loops = 0;
  const demolish = async (): Promise<void> => {
    loops++;
    await release.wait;
  };

  const first = runDemolishStep(store, session.id, { demolish });
  const second = runDemolishStep(store, session.id, { demolish });
  await tick();
  release.open();
  const results = await Promise.all([first, second]);

  expect(loops).toBe(1);
  expect(results.map(outcome).sort()).toEqual(["ok", "step_in_progress"]);
  expect((await store.loadSession(session.id))?.demolishDone).toBe(true);
});

test("a demolish request while a mess step is in flight is refused", async () => {
  const store = memoryStore();
  const session = await store.createSession(newSessionData());
  const release = gate();
  let loops = 0;

  const mess = runMessStep(store, session.id, "SETUP", {
    executeStep: async () => {
      await release.wait;
      return "hash";
    },
  });
  await tick();
  const demolish = await runDemolishStep(store, session.id, {
    demolish: async () => void loops++,
  });
  release.open();
  await mess;

  expect(outcome(demolish)).toBe("step_in_progress");
  expect(loops).toBe(0);
});

test("every confirmed demolish transaction and the done flag are persisted", async () => {
  const store = memoryStore();
  const session = await store.createSession(newSessionData());
  const operations: IntentOperation[] = [];

  const result = await runDemolishStep(store, session.id, {
    demolish: async (_session, onConfirmed) => {
      onConfirmed("tx-1", "hash-1", "first", operations);
      onConfirmed("tx-2", "hash-2", "second", operations);
    },
  });

  expect(outcome(result)).toBe("ok");
  const loaded = await store.loadSession(session.id);
  expect(loaded?.demolishLog.map((e) => e.hash)).toEqual(["hash-1", "hash-2"]);
  expect(loaded?.demolishDone).toBe(true);
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

test("an unknown session is a 404 and takes no lock", async () => {
  const store = memoryStore();
  const result = await runMessStep(store, "missing", "SETUP", {
    executeStep: async () => "hash",
  });
  expect(result.status).toBe(404);
  expect(await store.acquireLock("missing")).not.toBeNull();
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
    const result = await runDemolishStep(store, session.id, {
      demolish: async () => {
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
