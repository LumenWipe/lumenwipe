import { test, expect } from "bun:test";
import { Account, Keypair, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import {
  buildRemoveTrustlinesTx,
  trustlineAddForClaimOps,
} from "@/lib/stellar/tx-builder/trustlines";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import { BASE_FEE_STROOPS } from "@/config/constants";
import type { ClaimableBalance, Trustline } from "@lumenwipe/types";

const MASTER = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();

function trustline(over: Partial<Trustline> = {}): Trustline {
  return {
    asset: `USDC:${ISSUER}`,
    balance: "0",
    authorized: true,
    issuer: ISSUER,
    code: "USDC",
    ...over,
  };
}

function balance(asset: string): ClaimableBalance {
  return {
    id: "0".repeat(72),
    asset,
    amount: "1.0000000",
    claimants: [{ destination: MASTER, predicate: { type: "unconditional" } }],
    sponsor: null,
  };
}

test("trustlineAddForClaimOps > n balances -> n changeTrust ops, one per asset", () => {
  const ops = trustlineAddForClaimOps([balance(`USDC:${ISSUER}`), balance(`EURC:${ISSUER}`)]);
  expect(ops).toHaveLength(2);
});

test("trustlineAddForClaimOps > omits the limit, letting the SDK default to the maximum", () => {
  const [op] = trustlineAddForClaimOps([balance(`USDC:${ISSUER}`)]);
  const decoded = Operation.fromXDRObject(op!) as { limit: string };
  // The SDK's max trustline limit, per its own INT64_MAX default.
  expect(decoded.limit).toBe("922337203685.4775807");
});

test("buildRemoveTrustlinesTx > n trustlines -> n changeTrust(limit: 0) ops, fee scales linearly", () => {
  const account = new Account(MASTER, "100");
  const xdr = buildRemoveTrustlinesTx(
    account,
    [trustline({ code: "USDC" }), trustline({ code: "EURC", asset: `EURC:${ISSUER}` })],
    "testnet"
  );

  const tx = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASES.testnet);
  expect(tx.operations).toHaveLength(2);
  for (const op of tx.operations) {
    expect(op.type).toBe("changeTrust");
    expect((op as { limit: string }).limit).toBe("0.0000000");
  }
  expect(Number(tx.fee)).toBe(BASE_FEE_STROOPS * 2);
});

test("buildRemoveTrustlinesTx > a single trustline produces a single op at the base fee", () => {
  const account = new Account(MASTER, "100");
  const xdr = buildRemoveTrustlinesTx(account, [trustline()], "testnet");

  const tx = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASES.testnet);
  expect(tx.operations).toHaveLength(1);
  expect(Number(tx.fee)).toBe(BASE_FEE_STROOPS);
});
