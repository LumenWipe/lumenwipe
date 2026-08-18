import { test, expect } from "bun:test";
import { Account, Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { buildClaimBalancesTx, claimBalanceOps } from "@/lib/stellar/tx-builder/claimable-balances";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import { BASE_FEE_STROOPS } from "@/config/constants";
import type { ClaimableBalance } from "@lumenwipe/types";

const MASTER = Keypair.random().publicKey();

function balance(id: string): ClaimableBalance {
  return {
    id,
    asset: "native",
    amount: "1.0000000",
    claimants: [{ destination: MASTER, predicate: { type: "unconditional" } }],
    sponsor: null,
  };
}

test("claimBalanceOps > n balances -> n claim operations, one per balance id", () => {
  const ops = claimBalanceOps([balance("0".repeat(72)), balance(`00000000${"1".repeat(64)}`)]);
  expect(ops).toHaveLength(2);
});

test("buildClaimBalancesTx > fees scale with the number of balances claimed", () => {
  const account = new Account(MASTER, "100");
  const xdr = buildClaimBalancesTx(
    account,
    [balance("0".repeat(72)), balance(`00000000${"1".repeat(64)}`)],
    "testnet"
  );

  const tx = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASES.testnet);
  expect(tx.operations).toHaveLength(2);
  expect(tx.operations.every((op) => op.type === "claimClaimableBalance")).toBe(true);
  expect(Number(tx.fee)).toBe(BASE_FEE_STROOPS * 2);
});

test("buildClaimBalancesTx > a single balance produces a single operation at the base fee", () => {
  const account = new Account(MASTER, "100");
  const xdr = buildClaimBalancesTx(account, [balance("0".repeat(72))], "testnet");

  const tx = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASES.testnet);
  expect(tx.operations).toHaveLength(1);
  expect(Number(tx.fee)).toBe(BASE_FEE_STROOPS);
});
