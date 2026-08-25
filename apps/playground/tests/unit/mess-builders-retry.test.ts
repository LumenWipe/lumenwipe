import { test, expect } from "bun:test";
import { Keypair, Operation } from "@stellar/stellar-sdk";
import { loadAccountWithRetry, buildSignSubmit, TxSubmitError } from "@/lib/mess-builders";

const ADDR = "GBOYVOCQNI34T7IO6RPNE6RZCVD7WNTFJZJUEX64RSQF6IJT5NFDRGMN";
const notFound = (addr: string) => new Error(`Account not found: ${addr}`);

test("loadAccountWithRetry retries while the account is not yet visible, then succeeds", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const result = await loadAccountWithRetry(
    async (addr) => {
      calls++;
      if (calls < 3) throw notFound(addr);
      return { id: addr };
    },
    ADDR,
    { attempts: 6, delayMs: 10, sleep: async (ms) => void sleeps.push(ms) }
  );
  expect(calls).toBe(3);
  expect(sleeps.length).toBe(2);
  expect(result.id).toBe(ADDR);
});

test("loadAccountWithRetry gives up after the attempt budget", async () => {
  let calls = 0;
  await expect(
    loadAccountWithRetry(
      async (addr) => {
        calls++;
        throw notFound(addr);
      },
      ADDR,
      { attempts: 4, delayMs: 1, sleep: async () => {} }
    )
  ).rejects.toThrow(/account not found/i);
  expect(calls).toBe(4);
});

test("loadAccountWithRetry does not retry unrelated errors", async () => {
  let calls = 0;
  await expect(
    loadAccountWithRetry(
      async () => {
        calls++;
        throw new Error("network unreachable");
      },
      ADDR,
      { attempts: 5, delayMs: 1, sleep: async () => {} }
    )
  ).rejects.toThrow(/network unreachable/);
  expect(calls).toBe(1);
});

function manageDataOp() {
  return Operation.manageData({ name: "k", value: "v" });
}

test("buildSignSubmit retries on tx_bad_seq, re-reading the account each attempt", async () => {
  const kp = Keypair.random();
  const seqs = ["100", "100", "101"];
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
  expect(submits).toBe(3);
  expect(reads).toBe(3);
  expect(sleeps.length).toBe(2);
});

test("buildSignSubmit retries on tx_no_account, then succeeds", async () => {
  const kp = Keypair.random();
  let submits = 0;

  const txHash = await buildSignSubmit(kp, [manageDataOp()], [], {
    loadAccount: async () => ({ sequenceNumber: () => "100" }),
    submit: async () => {
      submits++;
      if (submits < 2) throw new TxSubmitError("source missing", "tx_no_account");
      return { txHash: "cafe" };
    },
    sleep: async () => {},
  });

  expect(txHash).toBe("cafe");
  expect(submits).toBe(2);
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
  expect(submits).toBe(5);
});
