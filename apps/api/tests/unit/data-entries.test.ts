import { test, expect } from "bun:test";
import { Account, Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { buildRemoveDataEntriesTx } from "@/lib/stellar/tx-builder/data-entries";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import { BASE_FEE_STROOPS } from "@/config/constants";
import type { DataEntry } from "@lumenwipe/types";

const MASTER = Keypair.random().publicKey();

test("buildRemoveDataEntriesTx > n entries -> n manageData(value: null) ops, fee scales linearly", () => {
  const entries: DataEntry[] = [
    { key: "a", value: "" },
    { key: "b", value: "" },
  ];
  const account = new Account(MASTER, "100");
  const xdr = buildRemoveDataEntriesTx(account, entries, "testnet");

  const tx = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASES.testnet);
  expect(tx.operations).toHaveLength(2);
  for (const op of tx.operations) {
    expect(op.type).toBe("manageData");
    expect((op as { value: Buffer | undefined }).value).toBeUndefined();
  }
  expect(Number(tx.fee)).toBe(BASE_FEE_STROOPS * 2);
});

test("buildRemoveDataEntriesTx > a single entry produces a single op at the base fee", () => {
  const account = new Account(MASTER, "100");
  const xdr = buildRemoveDataEntriesTx(account, [{ key: "a", value: "" }], "testnet");

  const tx = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASES.testnet);
  expect(tx.operations).toHaveLength(1);
  expect(Number(tx.fee)).toBe(BASE_FEE_STROOPS);
});
