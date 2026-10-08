import { afterEach, expect, spyOn, test } from "bun:test";
import { Account, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { CloseController } from "@/close/close.controller";
import * as submitModule from "@/lib/stellar/submit";
import type { StatsService } from "@/stats/stats.service";

const SOURCE = Keypair.random();
const HASH = "c".repeat(64);

function signed(op: ReturnType<typeof Operation.accountMerge>): string {
  const tx = new TransactionBuilder(new Account(SOURCE.publicKey(), "100"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();
  tx.sign(SOURCE);
  return tx.toXDR();
}

function controller(record: StatsService["record"]) {
  const calls: Array<[string, string]> = [];
  const stats = {
    record: (network: Parameters<StatsService["record"]>[0], hash: string) => {
      calls.push([network, hash]);
      return record(network, hash);
    },
  } as unknown as StatsService;
  return { controller: new CloseController(stats), calls };
}

afterEach(() => {
  spyOn(submitModule, "submitAndWait").mockRestore();
});

test("a confirmed merge submitted through the API is counted", async () => {
  spyOn(submitModule, "submitAndWait").mockResolvedValue({ txHash: HASH, ledger: 7 });
  const { controller: c, calls } = controller(async () => "counted");
  const xdr = signed(Operation.accountMerge({ destination: Keypair.random().publicKey() }));
  expect(await c.submit("testnet", { signedXdr: xdr })).toEqual({
    status: "success",
    hash: HASH,
    ledger: 7,
  });
  expect(calls).toEqual([["testnet", HASH]]);
});

test("a transaction without a merge is never sent to the counter", async () => {
  spyOn(submitModule, "submitAndWait").mockResolvedValue({ txHash: HASH, ledger: 7 });
  const { controller: c, calls } = controller(async () => "counted");
  await c.submit("testnet", { signedXdr: signed(Operation.bumpSequence({ bumpTo: "200" })) });
  expect(calls).toEqual([]);
});

test("a counter failure never fails a close that already confirmed", async () => {
  spyOn(submitModule, "submitAndWait").mockResolvedValue({ txHash: HASH, ledger: 7 });
  const { controller: c } = controller(async () => {
    throw new Error("firestore down");
  });
  const xdr = signed(Operation.accountMerge({ destination: Keypair.random().publicKey() }));
  expect((await c.submit("testnet", { signedXdr: xdr })).hash).toBe(HASH);
});
