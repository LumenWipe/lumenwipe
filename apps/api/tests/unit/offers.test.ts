import { test, expect } from "bun:test";
import { Account, Keypair, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { buildCancelOffersTx, offerCancellationOps } from "@/lib/stellar/tx-builder/offers";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import { BASE_FEE_STROOPS } from "@/config/constants";
import type { OpenOffer } from "@lumenwipe/types";

const MASTER = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();

function offer(over: Partial<OpenOffer> = {}): OpenOffer {
  return { id: "1", selling: "native", buying: `USDC:${ISSUER}`, amount: "5", price: "2", ...over };
}

test("offerCancellationOps > sets amount to 0 (cancels rather than modifies)", () => {
  const [op] = offerCancellationOps([offer({ amount: "5" })]);
  const decoded = Operation.fromXDRObject(op!) as { amount: string };
  expect(decoded.amount).toBe("0.0000000");
});

test("offerCancellationOps > falls back to price 1 when the offer carries no price", () => {
  const [op] = offerCancellationOps([offer({ price: "" })]);
  const decoded = Operation.fromXDRObject(op!) as { price: string };
  expect(decoded.price).toBe("1");
});

test("offerCancellationOps > preserves the offer's own price when set", () => {
  const [op] = offerCancellationOps([offer({ price: "3" })]);
  const decoded = Operation.fromXDRObject(op!) as { price: string };
  expect(decoded.price).toBe("3");
});

test("buildCancelOffersTx > n offers -> n manageSellOffer(amount: 0) ops, fee scales linearly", () => {
  const account = new Account(MASTER, "100");
  const xdr = buildCancelOffersTx(account, [offer({ id: "1" }), offer({ id: "2" })], "testnet");

  const tx = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASES.testnet);
  expect(tx.operations).toHaveLength(2);
  for (const op of tx.operations) {
    expect(op.type).toBe("manageSellOffer");
    expect((op as { amount: string }).amount).toBe("0.0000000");
  }
  expect(Number(tx.fee)).toBe(BASE_FEE_STROOPS * 2);
});

test("buildCancelOffersTx > a single offer produces a single op at the base fee", () => {
  const account = new Account(MASTER, "100");
  const xdr = buildCancelOffersTx(account, [offer()], "testnet");

  const tx = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASES.testnet);
  expect(tx.operations).toHaveLength(1);
  expect(Number(tx.fee)).toBe(BASE_FEE_STROOPS);
});
