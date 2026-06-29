import { test, expect } from "bun:test";
import { Keypair, Operation } from "@stellar/stellar-sdk";
import { buildSignSubmit } from "@/lib/playground/mess-builders";
import { translateRpcError, extractResultCode, TxSubmitError } from "@/lib/utils/errors";

// A real TransactionResult XDR captured from the Soroban RPC when a mess step was
// rejected: result switch = txBadSeq. The demo account's sequence lagged behind a
// just-confirmed tx, so the next step reused a stale sequence.
const BAD_SEQ_XDR = "AAAAAAAAAGT////7AAAAAA==";

test("translateRpcError surfaces tx_bad_seq instead of the generic ERROR message", () => {
  // Regression: "ERROR" has a generic entry in the map; decoding the XDR must win.
  expect(extractResultCode(BAD_SEQ_XDR)).toBe("tx_bad_seq");
  expect(translateRpcError("ERROR", BAD_SEQ_XDR)).toMatch(/sequence number/i);
  expect(translateRpcError("ERROR", BAD_SEQ_XDR)).not.toMatch(/rejected by the network/i);
});

test("translateRpcError still falls back to the generic message with no XDR", () => {
  expect(translateRpcError("ERROR")).toMatch(/rejected by the network/i);
});

function manageDataOp() {
  return Operation.manageData({ name: "k", value: "v" });
}

test("buildSignSubmit retries on tx_bad_seq, re-reading the account each attempt", async () => {
  const kp = Keypair.random();
  const seqs = ["100", "100", "101"]; // RPC stale twice, then catches up
  let reads = 0;
  let submits = 0;
  const sleeps: number[] = [];

  const txHash = await buildSignSubmit(kp, [manageDataOp()], [], {
    loadAccount: async () => ({ sequenceNumber: () => seqs[reads++] ?? "101" }),
    submit: async () => {
      submits++;
      if (submits < 3) throw new TxSubmitError("rejected", "tx_bad_seq");
      return { txHash: "deadbeef" };
    },
    sleep: async (ms) => void sleeps.push(ms),
  });

  expect(txHash).toBe("deadbeef");
  expect(submits).toBe(3); // failed twice, succeeded on the third
  expect(reads).toBe(3); // fresh account read before every attempt
  expect(sleeps.length).toBe(2); // waited between the failed attempts
});

test("buildSignSubmit retries on tx_no_account (lagging RPC node), then succeeds", async () => {
  const kp = Keypair.random();
  let submits = 0;
  const sleeps: number[] = [];

  const txHash = await buildSignSubmit(kp, [manageDataOp()], [], {
    loadAccount: async () => ({ sequenceNumber: () => "100" }),
    submit: async () => {
      submits++;
      if (submits < 2) throw new TxSubmitError("source missing", "tx_no_account");
      return { txHash: "cafe" };
    },
    sleep: async (ms) => void sleeps.push(ms),
  });

  expect(txHash).toBe("cafe");
  expect(submits).toBe(2);
  expect(sleeps.length).toBe(1);
});

test("buildSignSubmit does not retry non-transient submission errors", async () => {
  const kp = Keypair.random();
  let submits = 0;

  await expect(
    buildSignSubmit(kp, [manageDataOp()], [], {
      loadAccount: async () => ({ sequenceNumber: () => "100" }),
      submit: async () => {
        submits++;
        throw new TxSubmitError("underfunded", "tx_insufficient_balance");
      },
      sleep: async () => {},
    })
  ).rejects.toThrow(/underfunded/);
  expect(submits).toBe(1);
});

test("buildSignSubmit gives up after the retry budget and rethrows", async () => {
  const kp = Keypair.random();
  let submits = 0;

  await expect(
    buildSignSubmit(kp, [manageDataOp()], [], {
      loadAccount: async () => ({ sequenceNumber: () => "100" }),
      submit: async () => {
        submits++;
        throw new TxSubmitError("rejected", "tx_bad_seq");
      },
      sleep: async () => {},
    })
  ).rejects.toBeInstanceOf(TxSubmitError);
  expect(submits).toBe(5); // SUBMIT_RETRY_MAX_ATTEMPTS
});
