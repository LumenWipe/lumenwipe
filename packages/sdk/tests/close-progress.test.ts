import { expect, test } from "bun:test";
import type {
  CloseTransaction,
  StepType,
  TransactionLookupResponse,
  TransactionsResponse,
} from "@lumenwipe/types";
import {
  CloseDidNotConvergeError,
  InsufficientSignatureWeightError,
  runClose,
  type CloseEngineDeps,
  type CloseProgressEvent,
  type PendingRound,
} from "../src/close-engine";

function tx(order: number, covers: StepType[] = ["CANCEL_OFFERS"]): CloseTransaction {
  return { id: `tx${order}`, order, xdr: `xdr-tx${order}`, covers } as unknown as CloseTransaction;
}

function resp(transactions: CloseTransaction[], requiresAnotherCall: boolean, steps = 1) {
  return {
    planHash: "h",
    status: "ready",
    transactions,
    remaining: { steps: requiresAnotherCall ? steps : 0, requiresAnotherCall },
  } as TransactionsResponse;
}

/** Deps that answer `rounds` in order and record every progress event and message. */
function recording(rounds: TransactionsResponse[], extra: Partial<CloseEngineDeps> = {}) {
  const events: CloseProgressEvent[] = [];
  const messages: string[] = [];
  let i = 0;
  const deps: CloseEngineDeps = {
    getTransactions: async () => rounds[i++],
    verify: () => {},
    requiredWeight: () => 1,
    sign: async (_t, xdr) => ({ xdr, weight: 1 }),
    submit: async (t) => `hash-${t.order}`,
    onProgress: (message) => messages.push(message),
    onProgressEvent: (event) => events.push(event),
    ...extra,
  };
  return { deps, events, messages };
}

/** The four transaction phases of one transaction that goes through, in order. */
function through(
  round: number,
  txIndex: number,
  txCount: number,
  moreRoundsExpected: boolean,
  covers: StepType[] = ["CANCEL_OFFERS"],
  from: "verifying" | "awaiting-signature" = "verifying"
): CloseProgressEvent[] {
  const phases = ["verifying", "awaiting-signature", "submitting", "confirmed"] as const;
  return phases
    .slice(phases.indexOf(from))
    .map((phase) => ({ phase, round, txIndex, txCount, covers, moreRoundsExpected }));
}

const preparing = (round: number): CloseProgressEvent => ({ phase: "preparing", round });

async function thrown(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (e: unknown) => e
  );
}

test("progress › a single round reports every transition of each transaction, in order", async () => {
  const { deps, events } = recording([resp([tx(1), tx(0)], false)]);
  await runClose(deps);
  expect(events).toEqual([preparing(0), ...through(0, 0, 2, false), ...through(0, 1, 2, false)]);
});

test("progress › a multi-round close numbers rounds and says when more are expected", async () => {
  const { deps, events } = recording([resp([tx(0), tx(1)], true), resp([tx(2)], false)]);
  await runClose(deps);
  expect(events).toEqual([
    preparing(0),
    ...through(0, 0, 2, true),
    ...through(0, 1, 2, true),
    preparing(1),
    ...through(1, 0, 1, false),
  ]);
});

test("progress › a resumed multisig close continues the numbering where it stopped", async () => {
  // Round 1's first transaction is short of weight on the first run.
  const first = recording([resp([tx(0)], true), resp([tx(1), tx(2)], false)], {
    requiredWeight: (t) => (t.order === 1 ? 2 : 1),
  });
  const error = await thrown(runClose(first.deps));
  expect(error).toBeInstanceOf(InsufficientSignatureWeightError);
  const pending = (error as InsufficientSignatureWeightError).pending;
  expect(pending).toMatchObject({ round: 1, txIndex: 0, txCount: 2 });
  expect(first.events).toEqual([
    preparing(0),
    ...through(0, 0, 1, true),
    preparing(1),
    ...through(1, 0, 2, false).slice(0, 2),
  ]);

  const second = recording([], { requiredWeight: (t) => (t.order === 1 ? 2 : 1) });
  second.deps.sign = async (_t, xdr) => ({ xdr, weight: 2 });
  await runClose(second.deps, pending);
  expect(second.events).toEqual([
    ...through(1, 0, 2, false, undefined, "awaiting-signature"),
    ...through(1, 1, 2, false),
  ]);
});

test("progress › rounds after a resume are numbered from the resumed round", async () => {
  const pending: PendingRound = {
    tx: tx(0),
    xdr: "partial",
    requiredWeight: 1,
    accumulatedWeight: 0,
    queue: [tx(1)],
    requiresAnotherCall: true,
    round: 3,
    txIndex: 1,
    txCount: 3,
  };
  const { deps, events } = recording([resp([tx(2)], false)]);
  await runClose(deps, pending);
  expect(events).toEqual([
    ...through(3, 1, 3, true, undefined, "awaiting-signature"),
    ...through(3, 2, 3, true),
    preparing(4),
    ...through(4, 0, 1, false),
  ]);
});

test("progress › a hand-built PendingRound without positions counts from its queue", async () => {
  const pending: PendingRound = {
    tx: tx(0),
    xdr: "partial",
    requiredWeight: 1,
    accumulatedWeight: 0,
    queue: [tx(1), tx(2)],
    requiresAnotherCall: true,
  };
  const { deps, events } = recording([resp([tx(3)], false)]);
  await runClose(deps, pending);
  expect(events).toEqual([
    ...through(0, 0, 3, true, undefined, "awaiting-signature"),
    ...through(0, 1, 3, true),
    ...through(0, 2, 3, true),
    preparing(1),
    ...through(1, 0, 1, false),
  ]);
});

test("progress › a PendingRound with an index but no count counts the rest from that index", async () => {
  const pending: PendingRound = {
    tx: tx(0),
    xdr: "partial",
    requiredWeight: 1,
    accumulatedWeight: 0,
    queue: [tx(1)],
    requiresAnotherCall: false,
    txIndex: 2,
  };
  const { deps, events } = recording([]);
  await runClose(deps, pending);
  expect(events).toEqual([
    ...through(0, 2, 4, false, undefined, "awaiting-signature"),
    ...through(0, 3, 4, false),
  ]);
});

test("progress › an explicit round bound counts the resumed run's own rounds, as before", async () => {
  const pending: PendingRound = {
    tx: tx(0),
    xdr: "partial",
    requiredWeight: 1,
    accumulatedWeight: 0,
    queue: [],
    requiresAnotherCall: true,
    round: 7,
    txIndex: 0,
    txCount: 1,
  };
  let calls = 0;
  const { deps, events } = recording([], {
    getTransactions: async () => {
      calls++;
      return resp([tx(calls)], true);
    },
    maxRounds: 3,
  });
  const error = await thrown(runClose(deps, pending));
  expect(error).toBeInstanceOf(CloseDidNotConvergeError);
  expect(error).toMatchObject({ reason: "round_limit", rounds: 3, bound: 3 });
  expect(calls).toBe(3);
  expect(events.filter((e) => e.phase === "preparing").map((e) => e.round)).toEqual([8, 9, 10]);
});

test("progress › the derived round bound and its ceiling are unchanged after a resume", async () => {
  const pending: PendingRound = {
    tx: tx(0),
    xdr: "partial",
    requiredWeight: 1,
    accumulatedWeight: 0,
    queue: [],
    requiresAnotherCall: true,
    round: 50,
    txIndex: 0,
    txCount: 1,
  };
  let calls = 0;
  const { deps } = recording([], {
    getTransactions: async () => {
      calls++;
      return resp([tx(0)], true, 10_000);
    },
  });
  const error = await thrown(runClose(deps, pending));
  expect(error).toBeInstanceOf(CloseDidNotConvergeError);
  expect(error).toMatchObject({ reason: "round_limit", rounds: 200, bound: 200 });
  expect(calls).toBe(200);
});

test("progress › an empty batch after a resume reports this run's rounds and bound, as before", async () => {
  const pending: PendingRound = {
    tx: tx(0),
    xdr: "partial",
    requiredWeight: 1,
    accumulatedWeight: 0,
    queue: [],
    requiresAnotherCall: true,
    round: 50,
    txIndex: 0,
    txCount: 1,
  };
  const { deps } = recording([resp([tx(1)], true, 1), resp([], true, 1)]);
  const error = await thrown(runClose(deps, pending));
  expect(error).toBeInstanceOf(CloseDidNotConvergeError);
  // Round 0 of this run raised the bound to 0 + 1 + 1 step + a margin of 5.
  expect(error).toMatchObject({ reason: "empty_batch", rounds: 2, bound: 7 });
});

test("progress › both callbacks work together and the messages are unchanged", async () => {
  const { deps, events, messages } = recording([resp([tx(0)], true), resp([tx(1)], false)]);
  await runClose(deps);
  expect(messages).toEqual(["Preparing transactions…", "Preparing transactions…"]);
  expect(events).toHaveLength(10);
});

test("progress › a failed verification is the last event, nothing is asked to sign", async () => {
  const { deps, events } = recording([resp([tx(0), tx(1)], false)], {
    verify: () => {
      throw new Error("mismatch");
    },
  });
  await thrown(runClose(deps));
  expect(events).toEqual([preparing(0), ...through(0, 0, 2, false).slice(0, 1)]);
});

test("progress › a transaction short of weight is never reported as submitting", async () => {
  const { deps, events } = recording([resp([tx(0)], false)], { requiredWeight: () => 2 });
  await thrown(runClose(deps));
  expect(events.map((e) => e.phase)).toEqual(["preparing", "verifying", "awaiting-signature"]);
});

test("progress › submitting is reported once signed, before prepare and submit run", async () => {
  const log: string[] = [];
  const { deps } = recording([resp([tx(0)], false)], {
    sign: async (_t, xdr) => {
      log.push("sign");
      return { xdr, weight: 1 };
    },
    prepare: async (_t, xdr) => {
      log.push("prepare");
      return xdr;
    },
    submit: async () => {
      log.push("submit");
      return "h";
    },
    onConfirmed: () => log.push("onConfirmed"),
    onProgressEvent: (event) => log.push(event.phase),
  });
  await runClose(deps);
  expect(log).toEqual([
    "preparing",
    "verifying",
    "awaiting-signature",
    "sign",
    "submitting",
    "prepare",
    "submit",
    "onConfirmed",
    "confirmed",
  ]);
});

test("progress › a callback that throws or rejects cannot stop the close", async () => {
  for (const onProgressEvent of [
    () => {
      throw new Error("render failed");
    },
    async () => {
      throw new Error("render failed");
    },
  ]) {
    const submitted: number[] = [];
    const { deps } = recording([resp([tx(0), tx(1)], false)], {
      onProgressEvent,
      submit: async (t) => {
        submitted.push(t.order);
        return "h";
      },
    });
    await expect(runClose(deps)).resolves.toEqual({ mergeConfirmed: false });
    expect(submitted).toEqual([0, 1]);
  }
});

test("progress › every event is a fresh object that a callback cannot use to change the close", async () => {
  const original = tx(0, ["CANCEL_OFFERS"]);
  const seen: CloseProgressEvent[] = [];
  const confirmedCovers: StepType[][] = [];
  const { deps } = recording([resp([original, tx(1, ["MERGE"])], false)], {
    onProgressEvent: (event) => {
      seen.push(structuredClone(event));
      if (event.phase !== "preparing") {
        event.covers.push("MERGE");
        event.covers.splice(0, 1);
        event.txIndex = 99;
      }
    },
    onConfirmed: (t) => confirmedCovers.push([...t.covers]),
  });
  await runClose(deps);
  expect(seen).toEqual([
    preparing(0),
    ...through(0, 0, 2, false),
    ...through(0, 1, 2, false, ["MERGE"]),
  ]);
  expect(original.covers).toEqual(["CANCEL_OFFERS"]);
  expect(confirmedCovers).toEqual([["CANCEL_OFFERS"], ["MERGE"]]);
});

test("progress › with reconcile, confirmed carries the parsed covers and a resend adds no event", async () => {
  const HASH = "a".repeat(64);
  let sends = 0;
  const confirmedCovers: StepType[][] = [];
  const { deps, events, messages } = recording([resp([tx(0, ["HANDLE_ASSETS", "MERGE"])], false)], {
    submit: async () => {
      if (sends++ === 0) throw new Error("connection dropped");
      return HASH;
    },
    sleep: async () => {},
    onConfirmed: (t) => confirmedCovers.push([...t.covers]),
    reconcile: {
      hashOf: () => HASH,
      // The client did not find a merge in the envelope, whatever the API claimed.
      closesAccount: () => false,
      validUntil: () => 500,
      lookup: async (): Promise<TransactionLookupResponse> => ({
        status: "confirmed",
        hash: HASH,
        ledger: 1,
      }),
    },
  });
  await runClose(deps);
  expect(sends).toBe(2);
  expect(messages).toEqual([
    "Preparing transactions…",
    "Still waiting for the network to confirm…",
  ]);
  expect(events).toEqual([
    preparing(0),
    ...through(0, 0, 1, false, ["HANDLE_ASSETS", "MERGE"]).slice(0, 3),
    ...through(0, 0, 1, false, ["HANDLE_ASSETS"]).slice(3),
  ]);
  expect(confirmedCovers).toEqual([["HANDLE_ASSETS"]]);
});
