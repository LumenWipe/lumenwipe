import { describe, expect, test } from "bun:test";
import type {
  CloseTransaction,
  TransactionLookupResponse,
  TransactionsResponse,
} from "@lumenwipe/types";
import {
  CloseOutcomeUnknownError,
  CloseTransactionFailedError,
  isSubmitRefused,
  resolveSubmission,
  runClose,
  SUBMISSION_GIVE_UP_MARGIN_SECONDS,
  SUBMIT_RESEND_ATTEMPTS,
  type CloseEngineDeps,
  type CloseReconciliation,
  type UnresolvedSubmission,
} from "../../src/close-engine";
import { LumenWipeApiError, LumenWipeTimeoutError } from "../../src/errors";

const HASH = "a".repeat(64);
const OTHER = "b".repeat(64);
const SIGNED = "signed-xdr";
const FINAL = "final-xdr";
const SEARCHED = {
  oldestLedger: 1,
  oldestLedgerCloseTime: 1,
  latestLedger: 2,
  latestLedgerCloseTime: 1000,
};

const merge = {
  id: "merge",
  order: 0,
  xdr: "unsigned",
  covers: ["MERGE"],
} as unknown as CloseTransaction;

const oneRound = (requiresAnotherCall = false): TransactionsResponse =>
  ({
    transactions: [merge],
    remaining: { requiresAnotherCall, steps: requiresAnotherCall ? 1 : 0 },
  }) as unknown as TransactionsResponse;

const notFound = (hash = HASH, closeTime = 1000): TransactionLookupResponse => ({
  status: "not_found",
  hash,
  searched: { ...SEARCHED, latestLedgerCloseTime: closeTime },
});
const confirmed = (hash = HASH): TransactionLookupResponse => ({
  status: "confirmed",
  hash,
  ledger: 7,
});

function harness(overrides: {
  submit?: () => Promise<string>;
  lookup?: (hash: string) => Promise<TransactionLookupResponse>;
  getTransactions?: CloseEngineDeps["getTransactions"];
  closesAccount?: boolean;
  unresolved?: UnresolvedSubmission;
  now?: () => number;
}) {
  const events = {
    sent: [] as string[],
    signed: 0,
    prepared: 0,
    confirmed: [] as string[],
    resolved: [] as string[],
    record: [] as (UnresolvedSubmission | null)[],
    fetched: 0,
    sleeps: 0,
  };
  const reconcile: CloseReconciliation = {
    hashOf: () => HASH,
    closesAccount: () => overrides.closesAccount ?? true,
    validUntil: () => 500,
    lookup: overrides.lookup ?? (async (hash) => notFound(hash)),
    onSubmission: (submission) => {
      events.record.push(submission);
    },
    unresolved: overrides.unresolved,
    onResolved: (submission) => events.resolved.push(submission.hash),
    now: overrides.now,
  };
  const deps: CloseEngineDeps = {
    getTransactions: async (request) => {
      events.fetched++;
      return overrides.getTransactions ? overrides.getTransactions(request) : oneRound();
    },
    verify: () => undefined,
    requiredWeight: () => 1,
    sign: async () => {
      events.signed++;
      return { xdr: SIGNED, weight: 1 };
    },
    prepare: async () => {
      events.prepared++;
      return FINAL;
    },
    submit: async (_tx, xdr) => {
      events.sent.push(xdr);
      return overrides.submit ? overrides.submit() : HASH;
    },
    reconcile,
    onConfirmed: (_tx, hash) => events.confirmed.push(hash),
    sleep: async () => {
      events.sleeps++;
    },
  };
  return { deps, events };
}

describe("resending", () => {
  test("a timeout then a confirmed resend finishes, sending the same bytes", async () => {
    let calls = 0;
    const { deps, events } = harness({
      submit: async () => {
        if (calls++ === 0) throw new LumenWipeTimeoutError(45_000);
        return HASH;
      },
    });
    await runClose(deps);
    expect(events.sent).toEqual([FINAL, FINAL]);
    expect(events.confirmed).toEqual([HASH]);
    expect(events.signed).toBe(1);
    expect(events.prepared).toBe(1);
    expect(events.record[events.record.length - 1]).toBeNull();
  });

  test("the bound ends in an unknown outcome carrying the client's hash, not a failure", async () => {
    const { deps, events } = harness({
      submit: async () => {
        throw new LumenWipeApiError(504, { error: { code: "confirmation_timeout", message: "x" } });
      },
    });
    const failure = await runClose(deps).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(CloseOutcomeUnknownError);
    expect((failure as CloseOutcomeUnknownError).submission.hash).toBe(HASH);
    expect(events.sent).toHaveLength(1 + SUBMIT_RESEND_ATTEMPTS);
    expect(events.sleeps).toBe(SUBMIT_RESEND_ATTEMPTS);
    expect(events.record[events.record.length - 1]).not.toBeNull();
  });

  test("the record exists before the envelope is sent", async () => {
    const order: string[] = [];
    const { deps } = harness({});
    deps.reconcile!.onSubmission = (s) => void (s && order.push("record"));
    const submit = deps.submit;
    deps.submit = async (tx, xdr) => {
      order.push("send");
      return submit(tx, xdr);
    };
    await runClose(deps);
    expect(order).toEqual(["record", "send"]);
  });

  test("a refusal on the first attempt is surfaced and closes the record", async () => {
    const refusal = new LumenWipeApiError(422, {
      error: { code: "submit_rejected", message: "x" },
    });
    const { deps, events } = harness({
      submit: async () => {
        throw refusal;
      },
    });
    await expect(runClose(deps)).rejects.toBe(refusal);
    expect(events.sent).toHaveLength(1);
    expect(events.record[events.record.length - 1]).toBeNull();
  });

  test("a refusal on a resend proves nothing about the first send", async () => {
    let calls = 0;
    const { deps } = harness({
      submit: async () => {
        if (calls++ === 0) throw new TypeError("fetch failed");
        throw new LumenWipeApiError(422, { error: { code: "submit_rejected", message: "x" } });
      },
    });
    await expect(runClose(deps)).rejects.toBeInstanceOf(CloseOutcomeUnknownError);
  });

  test("a resend refused because the transaction failed on the ledger is that failure", async () => {
    let calls = 0;
    const { deps, events } = harness({
      submit: async () => {
        if (calls++ === 0) throw new TypeError("fetch failed");
        throw new LumenWipeApiError(422, { error: { code: "submit_rejected", message: "x" } });
      },
      lookup: async (hash) => ({ status: "failed", hash, ledger: 3, message: "Not enough XLM." }),
    });
    await expect(runClose(deps)).rejects.toBeInstanceOf(CloseTransactionFailedError);
    expect(events.record[events.record.length - 1]).toBeNull();
  });

  test("without reconcile a failed submit is surfaced and sent once", async () => {
    const { deps, events } = harness({
      submit: async () => {
        throw new LumenWipeTimeoutError(1);
      },
    });
    delete deps.reconcile;
    await expect(runClose(deps)).rejects.toBeInstanceOf(LumenWipeTimeoutError);
    expect(events.sent).toHaveLength(1);
    expect(events.record).toEqual([]);
  });
});

describe("the hash the API answers with", () => {
  test("another transaction's hash never confirms, even when a lookup agrees with the API", async () => {
    const { deps, events } = harness({
      submit: async () => OTHER,
      lookup: async () => confirmed(OTHER),
    });
    await expect(runClose(deps)).rejects.toBeInstanceOf(CloseOutcomeUnknownError);
    expect(events.confirmed).toEqual([]);
  });

  test("a lookup confirming the client's hash settles a mismatched answer", async () => {
    const { deps, events } = harness({
      submit: async () => OTHER,
      lookup: async (hash) => confirmed(hash),
    });
    await runClose(deps);
    expect(events.confirmed).toEqual([HASH]);
  });
});

describe("account_not_found", () => {
  const gone = Object.assign(new Error("gone"), { code: "account_not_found" });
  const submission: UnresolvedSubmission = { hash: HASH, covers: ["MERGE"], validUntil: 500 };
  const goneFetch = async (): Promise<TransactionsResponse> => {
    throw gone;
  };

  test("a left-over merge confirmed by its hash finishes with no fetch", async () => {
    const { deps, events } = harness({
      unresolved: submission,
      lookup: async (hash) => confirmed(hash),
      getTransactions: goneFetch,
    });
    await runClose(deps);
    expect(events.fetched).toBe(0);
    expect(events.resolved).toEqual([HASH]);
    expect(events.sent).toEqual([]);
    expect(events.signed).toBe(0);
  });

  test("a left-over hash still unknown stays unknown and fetches nothing", async () => {
    const { deps, events } = harness({
      unresolved: submission,
      now: () => 0,
      getTransactions: goneFetch,
    });
    await expect(runClose(deps)).rejects.toBeInstanceOf(CloseOutcomeUnknownError);
    expect(events.fetched).toBe(0);
    expect(events.sent).toEqual([]);
  });

  test("a left-over hash that failed surfaces the failure", async () => {
    const { deps } = harness({
      unresolved: submission,
      lookup: async (hash) => ({ status: "failed", hash, ledger: 3, message: "No." }),
    });
    await expect(runClose(deps)).rejects.toBeInstanceOf(CloseTransactionFailedError);
  });

  test("a failed lookup is unknown, never failed and never complete", async () => {
    const { deps, events } = harness({
      unresolved: submission,
      lookup: async () => {
        throw new LumenWipeApiError(503, { error: { code: "service_unavailable", message: "x" } });
      },
    });
    await expect(runClose(deps)).rejects.toBeInstanceOf(CloseOutcomeUnknownError);
    expect(events.resolved).toEqual([]);
  });

  test("a left-over transaction that is not a merge continues with the next round", async () => {
    const { deps, events } = harness({
      unresolved: { hash: HASH, covers: ["CANCEL_OFFERS"], validUntil: 500 },
      lookup: async (hash) => confirmed(hash),
    });
    await runClose(deps);
    expect(events.resolved).toEqual([HASH]);
    expect(events.fetched).toBe(1);
  });

  test("past the deadline the close returns to a live read and a missing account stays an error", async () => {
    const { deps, events } = harness({
      unresolved: submission,
      now: () => 10_000_000,
      getTransactions: goneFetch,
    });
    await expect(runClose(deps)).rejects.toBe(gone);
    expect(events.record[events.record.length - 1]).toBeNull();
    expect(events.resolved).toEqual([]);
    expect(events.sent).toEqual([]);
  });

  test("an expired left-over keeps the reviewed plan hash, a confirmed one drops it", async () => {
    const seen: (string | undefined)[] = [];
    const run = async (lookup: CloseReconciliation["lookup"]) => {
      const { deps } = harness({
        unresolved: { hash: HASH, covers: ["CANCEL_OFFERS"], validUntil: 500 },
        now: () => 10_000_000,
        lookup,
        getTransactions: async ({ planHash }) => {
          seen.push(planHash);
          return oneRound();
        },
      });
      await runClose({ ...deps, planHash: "reviewed" });
    };
    await run(async (hash) => notFound(hash));
    await run(async (hash) => confirmed(hash));
    expect(seen).toEqual(["reviewed", undefined]);
  });

  test("a merge this run confirmed ends the close when the next call finds no account", async () => {
    let fetches = 0;
    const { deps } = harness({
      lookup: async (hash) => confirmed(hash),
      getTransactions: async () => {
        if (fetches++ === 0) return oneRound(true);
        throw gone;
      },
    });
    await expect(runClose(deps)).resolves.toEqual({ mergeConfirmed: true });
  });

  test("a merge whose hash a lookup cannot confirm leaves account_not_found standing", async () => {
    let fetches = 0;
    const { deps } = harness({
      getTransactions: async () => {
        if (fetches++ === 0) return oneRound(true);
        throw gone;
      },
    });
    await expect(runClose(deps)).rejects.toBe(gone);
  });

  test("a transaction the client did not parse as a merge never explains a missing account", async () => {
    let fetches = 0;
    const { deps, events } = harness({
      closesAccount: false,
      lookup: async (hash) => confirmed(hash),
      getTransactions: async () => {
        if (fetches++ === 0) return oneRound(true);
        throw gone;
      },
    });
    await expect(runClose(deps)).rejects.toBe(gone);
    expect(events.record[0]?.covers).toEqual([]);
  });
});

describe("what a run may claim about a merge", () => {
  test("a transaction the client parsed as no merge reaches onConfirmed with no merge in covers", async () => {
    const seen: CloseTransaction["covers"][] = [];
    const { deps } = harness({ closesAccount: false });
    deps.onConfirmed = (tx) => seen.push(tx.covers);
    await expect(runClose(deps)).resolves.toEqual({ mergeConfirmed: false });
    expect(seen).toEqual([[]]);
  });

  test("a parsed merge counts even when the API forgot to say so", async () => {
    const { deps } = harness({
      getTransactions: async () =>
        ({
          transactions: [{ ...merge, covers: [] }],
          remaining: { requiresAnotherCall: false, steps: 0 },
        }) as unknown as TransactionsResponse,
    });
    await expect(runClose(deps)).resolves.toEqual({ mergeConfirmed: true });
  });

  test("without reconcile a run never claims a merge, whatever covers says", async () => {
    const { deps } = harness({});
    delete deps.reconcile;
    await expect(runClose(deps)).resolves.toEqual({ mergeConfirmed: false });
  });

  test("a left-over merge confirmed by hash claims one", async () => {
    const { deps } = harness({
      unresolved: { hash: HASH, covers: ["MERGE"], validUntil: 500 },
      lookup: async (hash) => confirmed(hash),
    });
    await expect(runClose(deps)).resolves.toEqual({ mergeConfirmed: true });
  });
});

describe("resolveSubmission", () => {
  const submission: UnresolvedSubmission = { hash: HASH, covers: ["MERGE"], validUntil: 1000 };
  const deadline = 1000 + SUBMISSION_GIVE_UP_MARGIN_SECONDS;
  const at = (seconds: number) => () => seconds * 1000;

  test("a lookup answering for another hash settles nothing", async () => {
    const outcome = await resolveSubmission(submission, async () => confirmed(OTHER));
    expect(outcome).toEqual({ outcome: "unknown" });
  });

  test("gives up only past the deadline", async () => {
    const lookup = async () => notFound(HASH, deadline + 1);
    expect(await resolveSubmission(submission, lookup, at(deadline))).toEqual({
      outcome: "unknown",
    });
    expect(await resolveSubmission(submission, lookup, at(deadline + 1))).toEqual({
      outcome: "expired",
    });
  });

  test("a client clock running far ahead cannot give up while the ledger is behind", async () => {
    const outcome = await resolveSubmission(
      submission,
      async () => notFound(HASH, deadline),
      () => Number.MAX_SAFE_INTEGER
    );
    expect(outcome).toEqual({ outcome: "unknown" });
  });

  test("a ledger time far ahead cannot give up while the client clock is behind", async () => {
    const outcome = await resolveSubmission(
      submission,
      async () => notFound(HASH, Number.MAX_SAFE_INTEGER),
      at(deadline)
    );
    expect(outcome).toEqual({ outcome: "unknown" });
  });

  test("a transaction with no time bounds is never given up on", async () => {
    const outcome = await resolveSubmission(
      { ...submission, validUntil: null },
      async () => notFound(HASH, Number.MAX_SAFE_INTEGER),
      at(Number.MAX_SAFE_INTEGER / 1000)
    );
    expect(outcome).toEqual({ outcome: "unknown" });
  });
});

describe("isSubmitRefused", () => {
  test("only a 4xx is a refusal", () => {
    const api = (status: number) => new LumenWipeApiError(status, {});
    for (const status of [400, 401, 422, 429]) expect(isSubmitRefused(api(status))).toBe(true);
    for (const error of [
      api(500),
      api(502),
      api(503),
      api(504),
      new LumenWipeTimeoutError(1),
      new TypeError("fetch failed"),
      new Error("anything else"),
      null,
      undefined,
      "text",
    ]) {
      expect(isSubmitRefused(error)).toBe(false);
    }
  });
});
