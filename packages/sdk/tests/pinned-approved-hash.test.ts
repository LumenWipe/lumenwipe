import { test, expect } from "bun:test";
import {
  runClose,
  ApprovedHashMismatchError,
  InsufficientSignatureWeightError,
  type CloseEngineDeps,
  type CloseProgressEvent,
  type PendingRound,
} from "../src/close-engine";
import type { CloseTransaction, TransactionsResponse } from "@lumenwipe/types";

function tx(order: number, id = `tx${order}`): CloseTransaction {
  return {
    id,
    order,
    xdr: `xdr-${id}`,
    covers: ["NORMALIZE_SIGNERS"],
  } as unknown as CloseTransaction;
}

function resp(
  transactions: CloseTransaction[],
  requiresAnotherCall: boolean
): TransactionsResponse {
  return {
    planHash: "h",
    status: "ready",
    transactions,
    remaining: { steps: requiresAnotherCall ? 1 : 0, requiresAnotherCall },
  } as TransactionsResponse;
}

// Signatures are appended as "+sig-X" and never change the hash, as on the network.
const hashOf = (xdr: string): string => `hash(${xdr.split("+")[0]})`;

interface Recorded {
  calls: string[];
  signed: string[];
  prepared: string[];
  submitted: string[];
  events: CloseProgressEvent[];
}

function deps(
  overrides: Partial<CloseEngineDeps> = {},
  rounds: TransactionsResponse[] = [],
  signer = { name: "B", weight: 2 }
): CloseEngineDeps & { rec: Recorded } {
  const rec: Recorded = { calls: [], signed: [], prepared: [], submitted: [], events: [] };
  let i = 0;
  return {
    rec,
    getTransactions: async () => rounds[i++] ?? resp([], false),
    verify: (t) => {
      rec.calls.push(`verify:${t.id}`);
    },
    requiredWeight: () => 2,
    transactionHash: (xdr) => {
      rec.calls.push(`hash:${xdr}`);
      return hashOf(xdr);
    },
    sign: async (t, xdr) => {
      rec.calls.push(`sign:${t.id}`);
      rec.signed.push(xdr);
      return { xdr: `${xdr}+sig-${signer.name}`, weight: signer.weight };
    },
    prepare: async (t, xdr) => {
      rec.prepared.push(xdr);
      return `${xdr}+prepared`;
    },
    submit: async (t, xdr) => {
      rec.submitted.push(xdr);
      return `submitted-${t.id}`;
    },
    onProgressEvent: (event) => {
      rec.events.push(event);
    },
    ...overrides,
  };
}

async function pauseRound(): Promise<PendingRound> {
  const d = deps({}, [resp([tx(0), tx(1)], true)], { name: "A", weight: 1 });
  try {
    await runClose(d);
  } catch (error) {
    if (error instanceof InsufficientSignatureWeightError) return error.pending;
    throw error;
  }
  throw new Error("the round did not pause");
}

async function caught(run: Promise<unknown>): Promise<unknown> {
  try {
    await run;
  } catch (error) {
    return error;
  }
  return null;
}

const nothingSent = (rec: Recorded): void => {
  expect(rec.prepared).toEqual([]);
  expect(rec.submitted).toEqual([]);
};

test("pinned hash › a paused round carries the hash of the verified xdr, taken after verify", async () => {
  const d = deps({}, [resp([tx(0)], false)], { name: "A", weight: 1 });
  const error = await caught(runClose(d));
  expect(error).toBeInstanceOf(InsufficientSignatureWeightError);
  const pending = (error as InsufficientSignatureWeightError).pending;
  expect(pending.approvedHash).toBe(hashOf("xdr-tx0"));
  expect(pending.xdr).toBe("xdr-tx0+sig-A");
  expect(d.rec.calls).toEqual(["verify:tx0", "hash:xdr-tx0", "sign:tx0", "hash:xdr-tx0+sig-A"]);
});

test("pinned hash › without transactionHash a paused round carries no approved hash", async () => {
  const d = deps({ transactionHash: undefined }, [resp([tx(0)], false)], {
    name: "A",
    weight: 1,
  });
  const pending = ((await caught(runClose(d))) as InsufficientSignatureWeightError).pending;
  expect("approvedHash" in pending).toBe(false);
});

test("pinned hash › a resumed round at full weight goes to prepare with no signer call", async () => {
  const pending = await pauseRound();
  const merged = { ...pending, xdr: `${pending.xdr}+sig-C`, accumulatedWeight: 2 };
  const d = deps({}, [resp([tx(2)], false)]);
  await runClose(d, merged);
  expect(d.rec.signed).toEqual(["xdr-tx1", "xdr-tx2"]);
  expect(d.rec.prepared[0]).toBe("xdr-tx0+sig-A+sig-C");
  expect(d.rec.submitted[0]).toBe("xdr-tx0+sig-A+sig-C+prepared");
  expect(d.rec.submitted).toHaveLength(3);
  const first = d.rec.events.filter((e) => "txIndex" in e && e.txIndex === 0 && e.round === 0);
  expect(first.map((e) => e.phase)).toEqual(["submitting", "confirmed"]);
});

test("pinned hash › the skip path emits what a signed round emits from submitting on", async () => {
  const pending = await pauseRound();
  const signedRun = deps();
  await runClose(signedRun, pending);
  const skipped = deps();
  await runClose(skipped, { ...pending, accumulatedWeight: 2 });
  const fromSubmitting = (events: CloseProgressEvent[]): CloseProgressEvent[] =>
    events.slice(events.findIndex((e) => e.phase === "submitting"));
  expect(fromSubmitting(skipped.rec.events)).toEqual(fromSubmitting(signedRun.rec.events));
  expect(signedRun.rec.events[0]?.phase).toBe("awaiting-signature");
  expect(skipped.rec.events[0]?.phase).toBe("submitting");
});

test("pinned hash › a resumed round below weight still asks the signer", async () => {
  const pending = await pauseRound();
  const d = deps();
  await runClose(d, pending);
  expect(d.rec.signed[0]).toBe("xdr-tx0+sig-A");
  expect(d.rec.submitted[0]).toBe("xdr-tx0+sig-A+sig-B+prepared");
});

test("pinned hash › a resumed envelope with another body hash is refused before anything", async () => {
  const pending = await pauseRound();
  const d = deps();
  const error = await caught(
    runClose(d, { ...pending, xdr: "xdr-other+sig-A+sig-C", accumulatedWeight: 2 })
  );
  expect(error).toBeInstanceOf(ApprovedHashMismatchError);
  expect((error as ApprovedHashMismatchError).approvedHash).toBe(hashOf("xdr-tx0"));
  expect((error as ApprovedHashMismatchError).actualHash).toBe(hashOf("xdr-other"));
  expect(d.rec.signed).toEqual([]);
  nothingSent(d.rec);
});

test("pinned hash › a resumed envelope with another body hash is refused below weight too", async () => {
  const pending = await pauseRound();
  const d = deps();
  const error = await caught(runClose(d, { ...pending, xdr: "xdr-other+sig-A" }));
  expect(error).toBeInstanceOf(ApprovedHashMismatchError);
  expect(d.rec.signed).toEqual([]);
  nothingSent(d.rec);
});

test("pinned hash › a pinned round resumed without transactionHash is refused", async () => {
  const pending = await pauseRound();
  const d = deps({ transactionHash: undefined });
  const error = await caught(runClose(d, { ...pending, accumulatedWeight: 2 }));
  expect(error).toBeInstanceOf(ApprovedHashMismatchError);
  expect((error as ApprovedHashMismatchError).actualHash).toBeNull();
  expect(d.rec.signed).toEqual([]);
  nothingSent(d.rec);
});

test("pinned hash › a fee-bump envelope on resume fails the check", async () => {
  const pending = await pauseRound();
  const d = deps({
    transactionHash: (xdr) => (xdr.startsWith("feebump(") ? `hash(${xdr})` : hashOf(xdr)),
  });
  const error = await caught(
    runClose(d, { ...pending, xdr: `feebump(${pending.xdr})`, accumulatedWeight: 2 })
  );
  expect(error).toBeInstanceOf(ApprovedHashMismatchError);
  nothingSent(d.rec);
});

test("pinned hash › a signer that returns another body is refused, fresh and resumed", async () => {
  const swap = { sign: async () => ({ xdr: "xdr-attacker+sig-B", weight: 2 }) };
  const fresh = deps(swap, [resp([tx(0)], false)]);
  expect(await caught(runClose(fresh))).toBeInstanceOf(ApprovedHashMismatchError);
  nothingSent(fresh.rec);

  const pending = await pauseRound();
  const resumed = deps(swap);
  expect(await caught(runClose(resumed, pending))).toBeInstanceOf(ApprovedHashMismatchError);
  nothingSent(resumed.rec);
});

test("pinned hash › a signer that returns another body below weight is refused, not paused", async () => {
  const d = deps({ sign: async () => ({ xdr: "xdr-attacker+sig-B", weight: 1 }) }, [
    resp([tx(0)], false),
  ]);
  expect(await caught(runClose(d))).toBeInstanceOf(ApprovedHashMismatchError);
  nothingSent(d.rec);
});

test("pinned hash › a throwing transactionHash surfaces its error with nothing submitted", async () => {
  const boom = new Error("cannot parse");
  const fresh = deps(
    {
      transactionHash: () => {
        throw boom;
      },
    },
    [resp([tx(0)], false)]
  );
  expect(await caught(runClose(fresh))).toBe(boom);
  expect(fresh.rec.signed).toEqual([]);
  nothingSent(fresh.rec);

  const pending = await pauseRound();
  const resumed = deps({
    transactionHash: () => {
      throw boom;
    },
  });
  expect(await caught(runClose(resumed, { ...pending, accumulatedWeight: 2 }))).toBe(boom);
  expect(resumed.rec.signed).toEqual([]);
  nothingSent(resumed.rec);

  let hashes = 0;
  const afterSign = deps(
    {
      transactionHash: (xdr) => {
        if (++hashes > 1) throw boom;
        return hashOf(xdr);
      },
    },
    [resp([tx(0)], false)]
  );
  expect(await caught(runClose(afterSign))).toBe(boom);
  expect(afterSign.rec.signed).toEqual(["xdr-tx0"]);
  nothingSent(afterSign.rec);
});

test("pinned hash › an unpinned resume at full weight still calls the signer", async () => {
  const pending = await pauseRound();
  const { approvedHash: _dropped, ...unpinned } = pending;
  const d = deps();
  await runClose(d, { ...unpinned, accumulatedWeight: 2 });
  expect(d.rec.signed[0]).toBe("xdr-tx0+sig-A");
});

test("pinned hash › no weight, or an unreachable requirement, still calls the signer", async () => {
  const pending = await pauseRound();
  const zero = deps({ requiredWeight: () => 0 });
  await runClose(zero, { ...pending, accumulatedWeight: 0 });
  expect(zero.rec.signed[0]).toBe("xdr-tx0+sig-A");

  const unreachable = deps({ requiredWeight: () => Number.POSITIVE_INFINITY }, [], {
    name: "B",
    weight: 5,
  });
  const error = await caught(
    runClose(unreachable, { ...pending, accumulatedWeight: Number.POSITIVE_INFINITY })
  );
  expect(error).toBeInstanceOf(InsufficientSignatureWeightError);
  expect(unreachable.rec.signed).toEqual(["xdr-tx0+sig-A"]);
  nothingSent(unreachable.rec);
});

test("pinned hash › the skip path opens the submission on the final envelope's own hash", async () => {
  const pending = await pauseRound();
  const opened: (string | null)[] = [];
  const d = deps({
    reconcile: {
      hashOf: (xdr) => `final(${xdr})`,
      closesAccount: () => false,
      validUntil: () => null,
      lookup: async () => {
        throw new Error("not looked up");
      },
      onSubmission: (submission) => {
        opened.push(submission?.hash ?? null);
      },
    },
    submit: async (t, xdr) => `final(${xdr})`,
  });
  await runClose(d, { ...pending, accumulatedWeight: 2 });
  expect(opened[0]).toBe("final(xdr-tx0+sig-A+prepared)");
  expect(opened[1]).toBeNull();
});

test("pinned hash › a transactionHash that returns no hash stops the close before signing", async () => {
  for (const bad of [undefined, "", 42]) {
    const d = deps({ transactionHash: () => bad as unknown as string }, [resp([tx(0)], false)]);
    expect(await caught(runClose(d))).toBeInstanceOf(TypeError);
    expect(d.rec.signed).toEqual([]);
    nothingSent(d.rec);
  }
});

test("pinned hash › a NaN, negative or missing carried weight still calls the signer", async () => {
  const pending = await pauseRound();
  for (const weight of [Number.NaN, -1, null]) {
    const d = deps();
    await runClose(d, { ...pending, accumulatedWeight: weight as unknown as number });
    expect(d.rec.signed[0]).toBe("xdr-tx0+sig-A");
  }
});

test("pinned hash › a queued transaction whose signer returns another body is refused", async () => {
  const pending = await pauseRound();
  const d = deps({
    sign: async (t, xdr) => ({ xdr: t.id === "tx1" ? "xdr-attacker+sig-B" : xdr, weight: 2 }),
  });
  const error = await caught(runClose(d, { ...pending, accumulatedWeight: 2 }));
  expect(error).toBeInstanceOf(ApprovedHashMismatchError);
  expect((error as ApprovedHashMismatchError).tx.id).toBe("tx1");
  expect(d.rec.submitted).toEqual(["xdr-tx0+sig-A+prepared"]);
});
