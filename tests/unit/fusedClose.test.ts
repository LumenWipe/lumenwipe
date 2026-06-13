import { test, expect } from "bun:test";
import { Account, Keypair, TransactionBuilder, Networks } from "@stellar/stellar-sdk";
import {
  assembleFusedCloseOps,
  buildFusedCloseTx,
  type FusedCloseInput,
} from "@/lib/stellar/tx-builder/fused-close";

const MASTER = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const EXTRA = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();

function account() {
  return new Account(MASTER, "100");
}

function baseInput(over: Partial<FusedCloseInput> = {}): FusedCloseInput {
  return {
    needsSignerNormalization: false,
    signers: [{ key: MASTER, weight: 1, type: "ed25519_public_key" }],
    dataEntries: [],
    openOffers: [],
    conversions: [],
    trustlines: [],
    destinationAddress: DEST,
    memo: null,
    memoType: null,
    includeMerge: true,
    ...over,
  };
}

function opsOf(xdr: string) {
  return TransactionBuilder.fromXDR(xdr, Networks.TESTNET).operations;
}

test("buildFusedCloseTx > clean account with merge -> single accountMerge op", () => {
  const ops = opsOf(buildFusedCloseTx(account(), baseInput(), "testnet"));
  expect(ops).toHaveLength(1);
  expect(ops[0].type).toBe("accountMerge");
});

test("buildFusedCloseTx > includeMerge=false -> no accountMerge op", () => {
  const ops = opsOf(
    buildFusedCloseTx(
      account(),
      baseInput({ includeMerge: false, dataEntries: [{ key: "k", value: "" }] }),
      "testnet"
    )
  );
  expect(ops.every((o) => o.type !== "accountMerge")).toBe(true);
  expect(ops).toHaveLength(1); // just the manageData
});

test("buildFusedCloseTx > operation order is signers, data, offers, conversion, trustlines, merge", () => {
  const tl = {
    asset: `USDC:${ISSUER}`,
    balance: "10",
    authorized: true,
    issuer: ISSUER,
    code: "USDC",
  };
  const ops = opsOf(
    buildFusedCloseTx(
      account(),
      baseInput({
        needsSignerNormalization: true,
        signers: [
          { key: MASTER, weight: 1, type: "ed25519_public_key" },
          { key: EXTRA, weight: 1, type: "ed25519_public_key" },
        ],
        dataEntries: [{ key: "k", value: "" }],
        openOffers: [
          { id: "1", selling: "native", buying: `USDC:${ISSUER}`, amount: "1", price: "1" },
        ],
        conversions: [
          {
            trustline: tl,
            path: {
              fromAsset: tl.asset,
              toAsset: "native",
              path: [],
              estimatedReceive: "9",
              destMin: "8.9",
            },
          },
        ],
        trustlines: [tl],
      }),
      "testnet"
    )
  );
  expect(ops.map((o) => o.type)).toEqual([
    "setOptions",
    "setOptions",
    "manageData",
    "manageSellOffer",
    "pathPaymentStrictSend",
    "changeTrust",
    "accountMerge",
  ]);
});

test("buildFusedCloseTx > fee equals BASE_FEE * opCount", () => {
  const tx = TransactionBuilder.fromXDR(
    buildFusedCloseTx(account(), baseInput({ dataEntries: [{ key: "k", value: "" }] }), "testnet"),
    Networks.TESTNET
  );
  // 1 manageData + 1 accountMerge = 2 ops -> fee 200
  expect(tx.fee).toBe("200");
});

test("buildFusedCloseTx > no signer normalization when flag false (no stray setOptions)", () => {
  const ops = opsOf(
    buildFusedCloseTx(account(), baseInput({ dataEntries: [{ key: "k", value: "" }] }), "testnet")
  );
  expect(ops.every((o) => o.type !== "setOptions")).toBe(true);
});

test("assembleFusedCloseOps > counts ops for a representative input", () => {
  const tl = {
    asset: `USDC:${ISSUER}`,
    balance: "10",
    authorized: true,
    issuer: ISSUER,
    code: "USDC",
  };
  const ops = assembleFusedCloseOps(
    MASTER,
    baseInput({
      needsSignerNormalization: true,
      signers: [
        { key: MASTER, weight: 1, type: "ed25519_public_key" },
        { key: EXTRA, weight: 1, type: "ed25519_public_key" },
      ],
      dataEntries: [
        { key: "a", value: "" },
        { key: "b", value: "" },
      ],
      openOffers: [
        { id: "1", selling: "native", buying: `USDC:${ISSUER}`, amount: "1", price: "1" },
      ],
      conversions: [
        {
          trustline: tl,
          path: {
            fromAsset: tl.asset,
            toAsset: "native",
            path: [],
            estimatedReceive: "9",
            destMin: "8.9",
          },
        },
      ],
      trustlines: [tl],
    })
  );
  // signer normalization = 1 setOptions per extra signer (1) + 1 threshold reset = 2;
  // plus 2 manageData + 1 manageSellOffer + 1 pathPaymentStrictSend + 1 changeTrust +
  // 1 accountMerge = 8
  expect(ops).toHaveLength(8);
});

test("assembleFusedCloseOps > large input exceeds the 100-op protocol cap", () => {
  const dataEntries = Array.from({ length: 120 }, (_, i) => ({ key: `k${i}`, value: "" }));
  const ops = assembleFusedCloseOps(MASTER, baseInput({ dataEntries, includeMerge: true }));
  // 120 manageData + 1 accountMerge = 121, the count the build-time guard relies on
  expect(ops.length).toBeGreaterThan(100);
  expect(ops).toHaveLength(121);
});
