import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import {
  Account,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import {
  InsufficientSignatureWeightError,
  LumenWipeApiError,
  runClose,
  type AccountState,
  type CloseTransaction,
  type FetchLike,
} from "../../src/index";
import {
  FriendbotError,
  RetriesExhaustedError,
  describeError,
  fund,
  installErrorHandlers,
  requiredWeightFor,
  signerWeight,
  waitForAccount,
  type SignerState,
} from "../../examples/support";

const source = Keypair.random().publicKey();
const destination = Keypair.random().publicKey();
const state = { address: source } as AccountState;

function apiError(
  status: number,
  code: string,
  headers?: Record<string, string>
): LumenWipeApiError {
  return new LumenWipeApiError(
    status,
    { error: { code, message: code } },
    { get: (name: string) => headers?.[name] ?? null }
  );
}

/** A reader that throws each queued error once, then returns the account. */
function reader(errors: unknown[]): { read: () => Promise<AccountState>; calls: () => number } {
  let calls = 0;
  return {
    read: async () => {
      const error = errors[calls++];
      if (error !== undefined) throw error;
      return state;
    },
    calls: () => calls,
  };
}

function recordingSleep(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return { sleep: async (ms) => void waits.push(ms), waits };
}

describe("waitForAccount", () => {
  test("retries an account the network has not shown yet, then returns it", async () => {
    const r = reader([apiError(404, "account_not_found"), apiError(404, "account_not_found")]);
    const { sleep, waits } = recordingSleep();
    expect(await waitForAccount(r.read, source, { sleep, delayMs: 10 })).toBe(state);
    expect(r.calls()).toBe(3);
    expect(waits).toEqual([10, 10]);
  });

  test("retries a 503 and a connection failure", async () => {
    const r = reader([apiError(503, "upstream_error"), new TypeError("fetch failed")]);
    const { sleep } = recordingSleep();
    expect(await waitForAccount(r.read, source, { sleep })).toBe(state);
    expect(r.calls()).toBe(3);
  });

  test("rethrows a rejected key at once, without waiting", async () => {
    const fatal = apiError(401, "unauthorized");
    const r = reader([fatal]);
    const { sleep, waits } = recordingSleep();
    await expect(waitForAccount(r.read, source, { sleep })).rejects.toBe(fatal);
    expect(r.calls()).toBe(1);
    expect(waits).toEqual([]);
  });

  test("rethrows a rejected request and any non-API error at once", async () => {
    for (const fatal of [apiError(422, "invalid_address"), new Error("bug")]) {
      const r = reader([fatal]);
      const { sleep } = recordingSleep();
      await expect(waitForAccount(r.read, source, { sleep })).rejects.toBe(fatal);
      expect(r.calls()).toBe(1);
    }
  });

  test("waits as long as Retry-After says", async () => {
    const r = reader([apiError(429, "rate_limited", { "Retry-After": "2" })]);
    const { sleep, waits } = recordingSleep();
    await waitForAccount(r.read, source, { sleep, delayMs: 10 });
    expect(waits).toEqual([2000]);
  });

  test("gives up after its attempts with the last error as the cause", async () => {
    const last = new TypeError("fetch failed");
    const r = reader([last, last, last]);
    const { sleep, waits } = recordingSleep();
    const error = await waitForAccount(r.read, source, { sleep, attempts: 3 }).catch((e) => e);
    expect(error).toBeInstanceOf(RetriesExhaustedError);
    expect(error.cause).toBe(last);
    expect(r.calls()).toBe(3);
    expect(waits).toHaveLength(2);
  });

  // Friendbot has taken about 18 s to fund, longer than a 15 attempt window at 1 s.
  test("keeps waiting for an account Friendbot is slow to create", async () => {
    const r = reader(Array.from({ length: 20 }, () => apiError(404, "account_not_found")));
    const { sleep, waits } = recordingSleep();
    expect(await waitForAccount(r.read, source, { sleep })).toBe(state);
    expect(r.calls()).toBe(21);
    expect(waits).toHaveLength(20);
  });

  test("still rethrows a rejected key at once after the account was missing", async () => {
    const fatal = apiError(401, "unauthorized");
    const r = reader([
      apiError(404, "account_not_found"),
      apiError(404, "account_not_found"),
      fatal,
    ]);
    const { sleep, waits } = recordingSleep();
    await expect(waitForAccount(r.read, source, { sleep })).rejects.toBe(fatal);
    expect(r.calls()).toBe(3);
    expect(waits).toHaveLength(2);
  });

  test("gives up on a missing account after 90 attempts", async () => {
    const r = reader(Array.from({ length: 200 }, () => apiError(404, "account_not_found")));
    const { sleep, waits } = recordingSleep();
    const error = await waitForAccount(r.read, source, { sleep }).catch((e) => e);
    expect(error).toBeInstanceOf(RetriesExhaustedError);
    expect(error.message).toContain("after 90 attempts");
    expect(error.cause).toBeInstanceOf(LumenWipeApiError);
    expect(error.cause.code).toBe("account_not_found");
    expect(r.calls()).toBe(90);
    expect(waits).toHaveLength(89);
  });

  test("keeps the shorter budget for every other retryable error", async () => {
    const r = reader(Array.from({ length: 200 }, () => apiError(503, "unavailable")));
    const { sleep } = recordingSleep();
    const error = await waitForAccount(r.read, source, { sleep }).catch((e) => e);
    expect(error).toBeInstanceOf(RetriesExhaustedError);
    expect(r.calls()).toBe(15);
  });
});

describe("fund", () => {
  function friendbot(statuses: number[]): { fetch: FetchLike; calls: () => number } {
    let calls = 0;
    return {
      fetch: async () => new Response("", { status: statuses[calls++] ?? 200 }),
      calls: () => calls,
    };
  }

  test("retries a Friendbot 5xx", async () => {
    const f = friendbot([502]);
    await fund(source, { fetch: f.fetch, sleep: async () => {} });
    expect(f.calls()).toBe(2);
  });

  test("fails on a Friendbot 4xx without retrying", async () => {
    const f = friendbot([400]);
    const error = await fund(source, { fetch: f.fetch, sleep: async () => {} }).catch((e) => e);
    expect(error).toBeInstanceOf(FriendbotError);
    expect(f.calls()).toBe(1);
  });

  test("bounds each Friendbot request with a timeout signal", async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    await fund(source, {
      fetch: async (_url, init) => {
        signals.push(init?.signal);
        return new Response("", { status: 200 });
      },
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]?.aborted).toBe(false);
  });

  // The error Bun's fetch throws when the timeout signal fires, and when a caller aborts.
  test("Bun names a timed out fetch TimeoutError and a caller's abort AbortError", async () => {
    const timedOut = await fetch("http://127.0.0.1:9/", { signal: AbortSignal.timeout(0) }).catch(
      (e) => e
    );
    expect(timedOut).toBeInstanceOf(DOMException);
    expect(timedOut.name).toBe("TimeoutError");
    const aborted = await fetch("http://127.0.0.1:9/", { signal: AbortSignal.abort() }).catch(
      (e) => e
    );
    expect(aborted).toBeInstanceOf(DOMException);
    expect(aborted.name).toBe("AbortError");
  });

  test("retries a Friendbot request that timed out", async () => {
    let calls = 0;
    await fund(source, {
      fetch: async () => {
        if (calls++ === 0) throw new DOMException("The operation timed out.", "TimeoutError");
        return new Response("", { status: 200 });
      },
      sleep: async () => {},
    });
    expect(calls).toBe(2);
  });

  test("rethrows an aborted Friendbot request without retrying", async () => {
    let calls = 0;
    const abort = new DOMException("The operation was aborted.", "AbortError");
    const error = await fund(source, {
      fetch: async () => {
        calls++;
        throw abort;
      },
      sleep: async () => {},
    }).catch((e) => e);
    expect(error).toBe(abort);
    expect(calls).toBe(1);
  });
});

const signerState = (
  masterWeight: number,
  thresholds = { low: 1, med: 2, high: 5 }
): SignerState => ({
  signers: [{ key: source, weight: masterWeight, type: "ed25519_public_key" }],
  thresholds,
});

function closeTx(...ops: xdr.Operation[]): CloseTransaction {
  const builder = new TransactionBuilder(new Account(source, "1"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  }).setTimeout(60);
  for (const op of ops) builder.addOperation(op);
  return {
    id: "tx-1",
    xdr: builder.build().toEnvelope().toXdr("base64"),
    covers: [],
    intent: { summary: "close" },
  } as unknown as CloseTransaction;
}

describe("signing weight", () => {
  test("a merge needs the high threshold", () => {
    const tx = closeTx(
      Operation.manageData({ name: "k", value: null }),
      Operation.accountMerge({ destination })
    );
    expect(requiredWeightFor(tx, signerState(1), Networks.TESTNET)).toBe(5);
  });

  test("a data entry removal needs the medium threshold", () => {
    const tx = closeTx(Operation.manageData({ name: "k", value: null }));
    expect(requiredWeightFor(tx, signerState(1), Networks.TESTNET)).toBe(2);
  });

  test("set options is high only when it touches signers or thresholds", () => {
    const touching = closeTx(Operation.setOptions({ masterWeight: 0 }));
    const plain = closeTx(Operation.setOptions({ homeDomain: "example.com" }));
    expect(requiredWeightFor(touching, signerState(1), Networks.TESTNET)).toBe(5);
    expect(requiredWeightFor(plain, signerState(1), Networks.TESTNET)).toBe(2);
  });

  test("a zero threshold still needs one signature", () => {
    const tx = closeTx(Operation.accountMerge({ destination }));
    expect(
      requiredWeightFor(tx, signerState(1, { low: 0, med: 0, high: 0 }), Networks.TESTNET)
    ).toBe(1);
  });

  test("a key weighs what the signer list says, and nothing when absent", () => {
    expect(signerWeight(signerState(3), source)).toBe(3);
    expect(signerWeight(signerState(3), destination)).toBe(0);
  });

  test("a key short of the threshold stops the close with a resumable error", async () => {
    const st = signerState(1);
    const tx = closeTx(Operation.accountMerge({ destination }));
    let submitted = false;
    const error = await runClose({
      getTransactions: async () =>
        ({ transactions: [tx], remaining: { steps: 0, requiresAnotherCall: false } }) as never,
      verify: () => {},
      requiredWeight: (t) => requiredWeightFor(t, st, Networks.TESTNET),
      sign: async (_t, x) => ({ xdr: x, weight: signerWeight(st, source) }),
      submit: async () => {
        submitted = true;
        return "hash";
      },
    }).catch((e) => e);
    expect(error).toBeInstanceOf(InsufficientSignatureWeightError);
    expect(error.pending).toMatchObject({ requiredWeight: 5, accumulatedWeight: 1 });
    expect(submitted).toBe(false);
    expect(describeError(error).join("\n")).toContain("runClose(deps, error.pending)");
  });
});

describe("error output", () => {
  test("an API error prints its status, code, request id and details", () => {
    const error = new LumenWipeApiError(
      401,
      { error: { code: "unauthorized", message: "bad key", details: { hint: "x" } } },
      { get: (name: string) => (name === "X-Request-Id" ? "req-1" : null) }
    );
    const out = describeError(error).join("\n");
    expect(out).toContain("  status: 401\n  code: unauthorized");
    expect(out).toContain("requestId: req-1");
    expect(out).toContain('details: {"hint":"x"}');
  });

  test("a cause is printed under the error it explains", () => {
    const out = describeError(new RetriesExhaustedError("gave up", new TypeError("refused")));
    expect(out).toEqual(["RetriesExhaustedError: gave up", "  cause: TypeError: refused"]);
  });

  test("an unhandled rejection fails the run with the same output", () => {
    const target = Object.assign(new EventEmitter(), { exitCode: undefined as number | undefined });
    const lines: string[] = [];
    installErrorHandlers(target, (line) => lines.push(line));
    target.emit("unhandledRejection", apiError(500, "internal_error"));
    expect(target.exitCode).toBe(1);
    expect(lines[0]).toStartWith("LumenWipeApiError: ");
    expect(lines).toContain("  code: internal_error");
  });
});
