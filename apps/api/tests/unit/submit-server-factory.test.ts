import { afterEach, expect, spyOn, test } from "bun:test";
import { Account, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import type { rpc } from "@stellar/stellar-sdk";
import { submitterFor } from "@/common/ports";
import * as rpcModule from "@/lib/stellar/rpc";
import { submitAndWait } from "@/lib/stellar/submit";

const SOURCE = Keypair.random();

function signedXdr(): string {
  const tx = new TransactionBuilder(new Account(SOURCE.publicKey(), "1"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.bumpSequence({ bumpTo: "200" }))
    .setTimeout(30)
    .build();
  tx.sign(SOURCE);
  return tx.toXDR();
}

function confirmedServer(ledger: number): rpc.Server {
  return {
    getTransaction: async () => ({ status: "SUCCESS", ledger }),
  } as unknown as rpc.Server;
}

afterEach(() => {
  spyOn(rpcModule, "getRpcServer").mockRestore();
});

test("without a factory the shared RPC server for the network is used", async () => {
  const requested: string[] = [];
  spyOn(rpcModule, "getRpcServer").mockImplementation((network) => {
    requested.push(network);
    return confirmedServer(11);
  });
  const result = await submitAndWait(signedXdr(), "testnet");
  expect(result.ledger).toBe(11);
  expect(requested).toEqual(["testnet"]);
});

test("an injected factory is used instead of the shared server", async () => {
  const shared = spyOn(rpcModule, "getRpcServer").mockImplementation(() => confirmedServer(1));
  const requested: string[] = [];
  const result = await submitAndWait(signedXdr(), "testnet", undefined, (network) => {
    requested.push(network);
    return confirmedServer(22);
  });
  expect(result.ledger).toBe(22);
  expect(requested).toEqual(["testnet"]);
  expect(shared).not.toHaveBeenCalled();
});

test("the default submitter hands its factory to the submission", async () => {
  const requested: string[] = [];
  const result = await submitterFor((network) => {
    requested.push(network);
    return confirmedServer(33);
  }).submitAndWait(signedXdr(), "testnet");
  expect(result.ledger).toBe(33);
  expect(requested).toEqual(["testnet"]);
});
