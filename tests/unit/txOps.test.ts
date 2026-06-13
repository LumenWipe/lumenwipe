import { test, expect } from "bun:test";
import { Keypair, Operation } from "@stellar/stellar-sdk";
import { signerNormalizationOps } from "@/lib/stellar/tx-builder/signers";
import { dataEntryRemovalOps } from "@/lib/stellar/tx-builder/data-entries";
import { offerCancellationOps } from "@/lib/stellar/tx-builder/offers";
import { trustlineRemovalOps } from "@/lib/stellar/tx-builder/trustlines";
import { mergeOp } from "@/lib/stellar/tx-builder/merge";
import { assetConversionOp, issuerPaymentOp } from "@/lib/stellar/tx-builder/asset-conversion";
import type { Trustline } from "@/types/account";
import type { ConversionPath } from "@/types/plan";

const MASTER = Keypair.random().publicKey();
const EXTRA = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();

test("signerNormalizationOps > one extra signer -> 2 ops (remove + threshold reset)", () => {
  const ops = signerNormalizationOps(
    [
      { key: MASTER, weight: 1, type: "ed25519_public_key" },
      { key: EXTRA, weight: 1, type: "ed25519_public_key" },
    ],
    MASTER
  );
  expect(ops).toHaveLength(2);
});

test("signerNormalizationOps > no extra signers -> 1 op (threshold reset only)", () => {
  const ops = signerNormalizationOps(
    [{ key: MASTER, weight: 1, type: "ed25519_public_key" }],
    MASTER
  );
  expect(ops).toHaveLength(1);
});

test("dataEntryRemovalOps > n entries -> n ops", () => {
  expect(
    dataEntryRemovalOps([
      { key: "a", value: "" },
      { key: "b", value: "" },
    ])
  ).toHaveLength(2);
});

test("offerCancellationOps > n offers -> n ops", () => {
  const offers = [
    { id: "1", selling: "native", buying: `USDC:${ISSUER}`, amount: "1", price: "1" },
  ];
  expect(offerCancellationOps(offers)).toHaveLength(1);
});

test("trustlineRemovalOps > n trustlines -> n ops", () => {
  const tls = [
    { asset: `USDC:${ISSUER}`, balance: "0", authorized: true, issuer: ISSUER, code: "USDC" },
  ];
  expect(trustlineRemovalOps(tls)).toHaveLength(1);
});

test("mergeOp > returns a single operation", () => {
  expect(mergeOp(MASTER)).toBeDefined();
});

test("assetConversionOp > builds a path payment strict send op", () => {
  const accountId = Keypair.random().publicKey();
  const trustline: Trustline = {
    asset: `USDC:${ISSUER}`,
    balance: "100",
    authorized: true,
    issuer: ISSUER,
    code: "USDC",
  };
  const path: ConversionPath = {
    fromAsset: `USDC:${ISSUER}`,
    toAsset: "native",
    path: [],
    estimatedReceive: "99",
    destMin: "98",
  };
  const op = assetConversionOp(accountId, trustline, path);
  expect(Operation.fromXDRObject(op).type).toBe("pathPaymentStrictSend");
});

test("issuerPaymentOp > builds a payment op to the issuer", () => {
  const trustline: Trustline = {
    asset: `USDC:${ISSUER}`,
    balance: "100",
    authorized: true,
    issuer: ISSUER,
    code: "USDC",
  };
  const op = issuerPaymentOp(trustline);
  expect(Operation.fromXDRObject(op).type).toBe("payment");
});
