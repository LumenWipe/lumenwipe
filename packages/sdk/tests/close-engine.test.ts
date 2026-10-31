import { test, expect } from "bun:test";
import {
  runClose,
  InsufficientSignatureWeightError,
  CloseDidNotConvergeError,
  CloseStateChangedError,
  STATE_CHANGED_REFETCHES,
  STATE_CHANGED_REFETCH_DELAY_MS,
} from "../src/close-engine";
import type { CloseTransaction, TransactionsResponse } from "@lumenwipe/types";

function tx(order: number, id = `tx${order}`): CloseTransaction {
  return { id, order, xdr: `xdr-${id}` } as unknown as CloseTransaction;
}

function resp(
  transactions: CloseTransaction[],
  requiresAnotherCall: boolean,
  steps = requiresAnotherCall ? 1 : 0
): TransactionsResponse {
  return {
    planHash: "h",
    status: "ready",
    transactions,
    remaining: { steps, requiresAnotherCall },
  } as TransactionsResponse;
}

test("runClose › signs+submits all txs in order across rounds, then stops", async () => {
  const rounds = [resp([tx(1), tx(0)], true), resp([tx(2)], false)];
  let i = 0;
  const submitted: number[] = [];
  await runClose({
    getTransactions: async () => rounds[i++],
    verify: () => {},
    requiredWeight: () => 1,
    sign: async (t, xdr) => ({ xdr, weight: 1 }),
    submit: async (t) => {
      submitted.push(t.order);
      return `hash-${t.order}`;
    },
  });
  expect(submitted).toEqual([0, 1, 2]);
  expect(i).toBe(2);
});

test("runClose › verify then sign then submit, in that order, for each tx", async () => {
  const calls: string[] = [];
  await runClose({
    getTransactions: async () => resp([tx(0)], false),
    verify: (t) => {
      calls.push(`verify:${t.order}`);
    },
    requiredWeight: () => 1,
    sign: async (t, xdr) => {
      calls.push(`sign:${t.order}`);
      return { xdr, weight: 1 };
    },
    submit: async (t) => {
      calls.push(`submit:${t.order}`);
      return "h";
    },
  });
  expect(calls).toEqual(["verify:0", "sign:0", "submit:0"]);
});

test("runClose › a failed verification aborts before anything is signed", async () => {
  const signed: number[] = [];
  let err: Error | null = null;
  try {
    await runClose({
      getTransactions: async () => resp([tx(0), tx(1)], false),
      verify: (t) => {
        if (t.order === 0) throw new Error("merge to attacker");
      },
      requiredWeight: () => 1,
      sign: async (t, xdr) => {
        signed.push(t.order);
        return { xdr, weight: 1 };
      },
      submit: async () => "h",
    });
  } catch (e) {
    err = e as Error;
  }
  expect(err?.message).toBe("merge to attacker");
  expect(signed).toEqual([]);
});

test("runClose › a rejected async verification aborts before anything is signed", async () => {
  const signed: number[] = [];
  let err: Error | null = null;
  try {
    await runClose({
      getTransactions: async () => resp([tx(0), tx(1)], false),
      verify: async (t) => {
        if (t.order === 0) throw new Error("merge to attacker (async)");
      },
      requiredWeight: () => 1,
      sign: async (t, xdr) => {
        signed.push(t.order);
        return { xdr, weight: 1 };
      },
      submit: async () => "h",
    });
  } catch (e) {
    err = e as Error;
  }
  expect(err?.message).toBe("merge to attacker (async)");
  expect(signed).toEqual([]);
});

test("runClose › weight exactly meeting the requirement submits (boundary, not just exceeding)", async () => {
  const submitted: number[] = [];
  await runClose({
    getTransactions: async () => resp([tx(0)], false),
    verify: () => {},
    requiredWeight: () => 2,
    sign: async (t, xdr) => ({ xdr, weight: 2 }),
    submit: async (t) => {
      submitted.push(t.order);
      return "h";
    },
  });
  expect(submitted).toEqual([0]);
});

test("runClose › insufficient weight throws instead of submitting", async () => {
  const submitted: number[] = [];
  let err: unknown = null;
  try {
    await runClose({
      getTransactions: async () => resp([tx(0)], false),
      verify: () => {},
      requiredWeight: () => 2,
      sign: async (t, xdr) => ({ xdr, weight: 1 }),
      submit: async (t) => {
        submitted.push(t.order);
        return "h";
      },
    });
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(InsufficientSignatureWeightError);
  const weightErr = err as InsufficientSignatureWeightError;
  expect(weightErr.pending.accumulatedWeight).toBe(1);
  expect(weightErr.pending.requiredWeight).toBe(2);
  expect(weightErr.pending.tx.order).toBe(0);
  expect(submitted).toEqual([]); // never submitted an under-signed transaction
});

// Bun 1.3.11's `.rejects.toSatisfy` hands the predicate the un-awaited Promise (not the
// rejection reason) and still rethrows regardless of the predicate's return value, so this
// uses the same try/catch pattern as the rest of this file rather than the brief's original
// `.rejects.toSatisfy(...)` form. Assertions are unchanged from the brief.
test("runClose › insufficient weight throws a resumable PendingRound carrying the partial xdr", async () => {
  let err: unknown = null;
  try {
    await runClose({
      getTransactions: async () => resp([tx(0), tx(1)], false),
      verify: () => {},
      requiredWeight: () => 2,
      sign: async (t, xdr) => ({ xdr: `${xdr}-signed`, weight: 1 }),
      submit: async () => "hash",
    });
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(InsufficientSignatureWeightError);
  const pending = (err as InstanceType<typeof InsufficientSignatureWeightError>).pending;
  expect(pending.tx.order).toBe(0);
  expect(pending.xdr).toBe("xdr-tx0-signed");
  expect(pending.requiredWeight).toBe(2);
  expect(pending.accumulatedWeight).toBe(1);
  expect(pending.queue.map((t) => t.order)).toEqual([1]);
  expect(pending.requiresAnotherCall).toBe(false);
});

test("runClose › resume signs onto the carried xdr, never re-fetching or re-verifying that tx", async () => {
  const verifyCalls: number[] = [];
  const signXdrs: string[] = [];
  let getTransactionsCalls = 0;

  const pending = {
    tx: tx(0),
    xdr: "xdr-tx0-signed-by-A",
    requiredWeight: 2,
    accumulatedWeight: 1,
    queue: [tx(1)],
    requiresAnotherCall: false,
  };

  await runClose(
    {
      getTransactions: async () => {
        getTransactionsCalls++;
        return resp([], false);
      },
      verify: (t) => {
        verifyCalls.push(t.order);
      },
      requiredWeight: () => 2,
      sign: async (t, xdr) => {
        signXdrs.push(xdr);
        return { xdr: `${xdr}-by-B`, weight: 2 };
      },
      submit: async () => "hash",
    },
    pending
  );

  expect(signXdrs[0]).toBe("xdr-tx0-signed-by-A"); // resumed onto the carried xdr, not tx.xdr
  expect(verifyCalls).toEqual([1]); // tx0 not re-verified; tx1 (the queue) is verified once
  expect(getTransactionsCalls).toBe(0); // requiresAnotherCall was false - no refetch
});

test("runClose › resume that clears threshold continues the queue, then fetches another round if required", async () => {
  const submitted: number[] = [];
  const rounds = [resp([tx(2)], false)];
  let i = 0;

  const pending = {
    tx: tx(0),
    xdr: "xdr-tx0-partial",
    requiredWeight: 2,
    accumulatedWeight: 1,
    queue: [tx(1)],
    requiresAnotherCall: true,
  };

  await runClose(
    {
      getTransactions: async () => rounds[i++],
      verify: () => {},
      requiredWeight: () => 2,
      sign: async (t, xdr) => ({ xdr, weight: 2 }),
      submit: async (t) => {
        submitted.push(t.order);
        return `hash-${t.order}`;
      },
    },
    pending
  );

  expect(submitted).toEqual([0, 1, 2]);
  expect(i).toBe(1);
});

test("runClose › exact boundary (accumulated === required) submits, does not throw", async () => {
  const submitted: number[] = [];
  await runClose({
    getTransactions: async () => resp([tx(0)], false),
    verify: () => {},
    requiredWeight: () => 2,
    sign: async (t, xdr) => ({ xdr, weight: 2 }),
    submit: async (t) => {
      submitted.push(t.order);
      return "hash";
    },
  });
  expect(submitted).toEqual([0]);
});

test("runClose › bounded rounds - never loops forever", async () => {
  let err: Error | null = null;
  try {
    await runClose({
      getTransactions: async () => resp([tx(0)], true),
      verify: () => {},
      requiredWeight: () => 1,
      sign: async (t, xdr) => ({ xdr, weight: 1 }),
      submit: async () => "h",
      maxRounds: 3,
    });
  } catch (e) {
    err = e as Error;
  }
  expect(err).toBeInstanceOf(CloseDidNotConvergeError);
  expect(err).toMatchObject({ reason: "round_limit", rounds: 3, bound: 3 });
});

const deps = (getTransactions: () => Promise<TransactionsResponse>, extra = {}) => ({
  getTransactions,
  verify: () => {},
  requiredWeight: () => 1,
  sign: async (_t: CloseTransaction, xdr: string) => ({ xdr, weight: 1 }),
  submit: async () => "h",
  ...extra,
});

function sequence(total: number, steps: (round: number) => number) {
  let i = 0;
  return {
    get calls() {
      return i;
    },
    next: async (): Promise<TransactionsResponse> => {
      const round = i++;
      const last = round === total - 1;
      return resp([tx(0)], !last, last ? 0 : steps(round));
    },
  };
}

test("runClose › 30 rounds complete with default dependencies", async () => {
  const seq = sequence(30, (round) => 29 - round);
  await runClose(deps(seq.next));
  expect(seq.calls).toBe(30);
});

test("runClose › a low first steps value does not cut a long close short", async () => {
  const seq = sequence(40, (round) => (round < 15 ? 1 : 39 - round));
  await runClose(deps(seq.next));
  expect(seq.calls).toBe(40);
});

test("runClose › stops at the hard ceiling when the API never converges", async () => {
  let calls = 0;
  const err = await runClose(
    deps(async () => {
      calls++;
      return resp([tx(0)], true, 10_000);
    })
  ).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(CloseDidNotConvergeError);
  expect(err).toMatchObject({ reason: "round_limit", bound: 200 });
  expect(calls).toBe(200);
});

test("runClose › an explicit maxRounds above the ceiling is honored", async () => {
  const seq = sequence(250, () => 10_000);
  await runClose(deps(seq.next, { maxRounds: 300 }));
  expect(seq.calls).toBe(250);
});

test("runClose › an empty batch that asks for another call throws on the first occurrence", async () => {
  let calls = 0;
  const err = await runClose(
    deps(async () => {
      calls++;
      return resp([], true, 3);
    })
  ).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(CloseDidNotConvergeError);
  expect(err).toMatchObject({ reason: "empty_batch", rounds: 1 });
  expect(calls).toBe(1);
});

const stateChanged = Object.assign(new Error("state_changed"), { code: "state_changed" });

const noWait = async (): Promise<void> => {};

function engine(getTransactions: () => Promise<TransactionsResponse>, submitted: number[] = []) {
  return {
    getTransactions,
    sleep: noWait,
    verify: () => {},
    requiredWeight: () => 1,
    sign: async (_t: CloseTransaction, xdr: string) => ({ xdr, weight: 1 }),
    submit: async (t: CloseTransaction) => {
      submitted.push(t.order);
      return "h";
    },
  };
}

test("runClose › re-fetches a round the API refused as state_changed, at most twice", async () => {
  expect(STATE_CHANGED_REFETCHES).toBe(2);
  let calls = 0;
  const submitted: number[] = [];
  await runClose(
    engine(async () => {
      calls++;
      if (calls <= STATE_CHANGED_REFETCHES) throw stateChanged;
      return resp([tx(0)], false);
    }, submitted)
  );
  expect(calls).toBe(STATE_CHANGED_REFETCHES + 1);
  expect(submitted).toEqual([0]);
});

test("runClose › a round still refused as state_changed after the re-fetches asks for a new plan", async () => {
  let calls = 0;
  const submitted: number[] = [];
  const err = await runClose(
    engine(async () => {
      calls++;
      throw stateChanged;
    }, submitted)
  ).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(CloseStateChangedError);
  expect((err as CloseStateChangedError).apiError).toBe(stateChanged);
  expect(calls).toBe(STATE_CHANGED_REFETCHES + 1);
  expect(submitted).toEqual([]);
});

test("runClose › any other API error is not re-fetched", async () => {
  let calls = 0;
  const other = Object.assign(new Error("quote_drifted"), { code: "quote_drifted" });
  const err = await runClose(
    engine(async () => {
      calls++;
      throw other;
    })
  ).catch((e: unknown) => e);
  expect(err).toBe(other);
  expect(calls).toBe(1);
});

test("runClose › waits about one ledger close before each re-fetch, never before the first fetch", async () => {
  expect(STATE_CHANGED_REFETCH_DELAY_MS).toBe(3000);
  const events: string[] = [];
  let calls = 0;
  await runClose({
    ...engine(async () => {
      calls++;
      events.push(`fetch ${calls}`);
      if (calls <= STATE_CHANGED_REFETCHES) throw stateChanged;
      return resp([tx(0)], false);
    }),
    sleep: async (ms) => {
      events.push(`sleep ${ms}`);
    },
  });
  expect(events).toEqual([
    "fetch 1",
    `sleep ${STATE_CHANGED_REFETCH_DELAY_MS}`,
    "fetch 2",
    `sleep ${STATE_CHANGED_REFETCH_DELAY_MS}`,
    "fetch 3",
  ]);
});

test("runClose › a round that is not refused never waits", async () => {
  const waits: number[] = [];
  await runClose({
    ...engine(async () => resp([tx(0)], false)),
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  expect(waits).toEqual([]);
});
