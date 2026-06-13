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

// A valid claimable balance id is an 8-char discriminant + 64 hex chars.
function balanceId(hexChar: string) {
  return `00000000${hexChar.repeat(64)}`;
}

const TL = {
  asset: `USDC:${ISSUER}`,
  balance: "10",
  authorized: true,
  issuer: ISSUER,
  code: "USDC",
};

function convertPath() {
  return {
    fromAsset: TL.asset,
    toAsset: "native",
    path: [],
    estimatedReceive: "9",
    destMin: "8.9",
  };
}

function baseInput(over: Partial<FusedCloseInput> = {}): FusedCloseInput {
  return {
    needsSignerNormalization: false,
    signers: [{ key: MASTER, weight: 1, type: "ed25519_public_key" }],
    dataEntries: [],
    openOffers: [],
    claimableBalances: [],
    assetActions: [],
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

test("buildFusedCloseTx > operation order is signers, data, offers, claim, convert, issuer, trustlines, merge", () => {
  const issuerTl = {
    asset: `EURC:${ISSUER}`,
    balance: "5",
    authorized: true,
    issuer: ISSUER,
    code: "EURC",
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
        claimableBalances: [{ id: balanceId("d"), asset: "native", amount: "1" }],
        assetActions: [
          { trustline: TL, action: "convert", path: convertPath() },
          { trustline: issuerTl, action: "issuer" },
        ],
        trustlines: [TL, issuerTl],
      }),
      "testnet"
    )
  );
  expect(ops.map((o) => o.type)).toEqual([
    "setOptions",
    "setOptions",
    "manageData",
    "manageSellOffer",
    "claimClaimableBalance",
    "pathPaymentStrictSend",
    "payment",
    "changeTrust",
    "changeTrust",
    "accountMerge",
  ]);
});

test("buildFusedCloseTx > claim ops appear one per claimable balance", () => {
  const ops = opsOf(
    buildFusedCloseTx(
      account(),
      baseInput({
        includeMerge: false,
        claimableBalances: [
          { id: balanceId("a"), asset: "native", amount: "1" },
          { id: balanceId("b"), asset: `USDC:${ISSUER}`, amount: "2" },
        ],
      }),
      "testnet"
    )
  );
  expect(ops.filter((o) => o.type === "claimClaimableBalance")).toHaveLength(2);
});

test("buildFusedCloseTx > no claim ops when claimableBalances empty", () => {
  const ops = opsOf(
    buildFusedCloseTx(account(), baseInput({ dataEntries: [{ key: "k", value: "" }] }), "testnet")
  );
  expect(ops.every((o) => o.type !== "claimClaimableBalance")).toBe(true);
});

test("buildFusedCloseTx > issuer action produces a payment, not pathPaymentStrictSend", () => {
  const ops = opsOf(
    buildFusedCloseTx(
      account(),
      baseInput({
        includeMerge: false,
        assetActions: [{ trustline: TL, action: "issuer" }],
        trustlines: [TL],
      }),
      "testnet"
    )
  );
  expect(ops.some((o) => o.type === "payment")).toBe(true);
  expect(ops.every((o) => o.type !== "pathPaymentStrictSend")).toBe(true);
});

test("buildFusedCloseTx > convert action produces a pathPaymentStrictSend", () => {
  const ops = opsOf(
    buildFusedCloseTx(
      account(),
      baseInput({
        includeMerge: false,
        assetActions: [{ trustline: TL, action: "convert", path: convertPath() }],
        trustlines: [TL],
      }),
      "testnet"
    )
  );
  expect(ops.some((o) => o.type === "pathPaymentStrictSend")).toBe(true);
  expect(ops.every((o) => o.type !== "payment")).toBe(true);
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
      claimableBalances: [{ id: balanceId("c"), asset: "native", amount: "1" }],
      assetActions: [{ trustline: TL, action: "convert", path: convertPath() }],
      trustlines: [TL],
    })
  );
  // signer normalization = 1 setOptions per extra signer (1) + 1 threshold reset = 2;
  // plus 2 manageData + 1 manageSellOffer + 1 claimClaimableBalance +
  // 1 pathPaymentStrictSend + 1 changeTrust + 1 accountMerge = 9
  expect(ops).toHaveLength(9);
});

test("assembleFusedCloseOps > large input exceeds the 100-op protocol cap", () => {
  const dataEntries = Array.from({ length: 120 }, (_, i) => ({ key: `k${i}`, value: "" }));
  const ops = assembleFusedCloseOps(MASTER, baseInput({ dataEntries, includeMerge: true }));
  // 120 manageData + 1 accountMerge = 121, the count the build-time guard relies on
  expect(ops.length).toBeGreaterThan(100);
  expect(ops).toHaveLength(121);
});
