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

// Structurally valid claimable balance with an unconditional predicate for MASTER.
function cb(hexChar: string, asset: string, amount: string) {
  return {
    id: balanceId(hexChar),
    asset,
    amount,
    claimants: [{ destination: MASTER, predicate: { type: "unconditional" as const } }],
    sponsor: null,
  };
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
    revokeSponsorshipEntries: [],
    dataEntries: [],
    openOffers: [],
    claimableBalances: [],
    trustlinesToAddForClaim: [],
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
        claimableBalances: [cb("d", "native", "1")],
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
        claimableBalances: [cb("a", "native", "1"), cb("b", `USDC:${ISSUER}`, "2")],
      }),
      "testnet"
    )
  );
  expect(ops.filter((o) => o.type === "claimClaimableBalance")).toHaveLength(2);
});

test("buildFusedCloseTx > trustlinesToAddForClaim emits a changeTrust immediately before the claim", () => {
  const ops = opsOf(
    buildFusedCloseTx(
      account(),
      baseInput({
        includeMerge: false,
        claimableBalances: [cb("f", `USDC:${ISSUER}`, "5")],
        trustlinesToAddForClaim: [cb("f", `USDC:${ISSUER}`, "5")],
      }),
      "testnet"
    )
  );
  expect(ops.map((o) => o.type)).toEqual(["changeTrust", "claimClaimableBalance"]);
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
      claimableBalances: [cb("c", "native", "1")],
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

// ─── transfer disposition (#111) ─────────────────────────────────────────────

const TRANSFER_DEST = Keypair.random().publicKey();

test("a transfer disposition emits a payment of the full balance to the chosen account", () => {
  const ops = opsOf(
    buildFusedCloseTx(
      account(),
      baseInput({
        assetActions: [{ trustline: TL, action: "transfer", destination: TRANSFER_DEST }],
        trustlines: [TL],
      }),
      "testnet"
    )
  );

  const payment = ops.find((o) => o.type === "payment");
  expect(payment).toBeDefined();
  expect((payment as { destination: string }).destination).toBe(TRANSFER_DEST);
  // The full balance, not a parameter: the ChangeTrust below fails on any remainder. Compared
  // numerically because the SDK normalizes to 7 decimal places ("10" -> "10.0000000").
  expect(Number((payment as { amount: string }).amount)).toBe(Number(TL.balance));
  expect((payment as { asset: { code: string } }).asset.code).toBe("USDC");
});

test("the transfer payment precedes the ChangeTrust that removes its trustline", () => {
  const ops = opsOf(
    buildFusedCloseTx(
      account(),
      baseInput({
        assetActions: [{ trustline: TL, action: "transfer", destination: TRANSFER_DEST }],
        trustlines: [TL],
      }),
      "testnet"
    )
  );

  const paymentAt = ops.findIndex((o) => o.type === "payment");
  const changeTrustAt = ops.findIndex(
    (o) => o.type === "changeTrust" && Number((o as { limit?: string }).limit ?? "0") === 0
  );
  expect(paymentAt).toBeGreaterThanOrEqual(0);
  expect(changeTrustAt).toBeGreaterThanOrEqual(0);
  // Reversed, the ChangeTrust would fail on a non-zero balance and abort the whole atomic
  // close - the account stays open and the user is told nothing useful.
  expect(paymentAt).toBeLessThan(changeTrustAt);
});

test("a transfer goes to the chosen account, never to the issuer", () => {
  // Asserting only `not.toBe(ISSUER)` against a random destination cannot fail: it would pass
  // for any wrong address at all. Pinning the exact address is what makes it a real check.
  const ops = opsOf(
    buildFusedCloseTx(
      account(),
      baseInput({
        assetActions: [{ trustline: TL, action: "transfer", destination: TRANSFER_DEST }],
        trustlines: [TL],
      }),
      "testnet"
    )
  );
  const payment = ops.find((o) => o.type === "payment") as { destination: string };
  expect(payment.destination).toBe(TRANSFER_DEST);
  // The old `convert ? ... : issuer` ternary resolved everything non-convert to this.
  expect(payment.destination).not.toBe(ISSUER);
});

test("transfer composes with convert and issuer in one plan, each to its own destination", () => {
  const otherIssuer = Keypair.random().publicKey();
  const eurc = {
    asset: `EURC:${otherIssuer}`,
    balance: "5",
    authorized: true,
    issuer: otherIssuer,
    code: "EURC",
  };
  const foo = {
    asset: `FOO:${otherIssuer}`,
    balance: "3",
    authorized: true,
    issuer: otherIssuer,
    code: "FOO",
  };

  const ops = opsOf(
    buildFusedCloseTx(
      account(),
      baseInput({
        assetActions: [
          { trustline: TL, action: "convert", path: convertPath() },
          { trustline: eurc, action: "transfer", destination: TRANSFER_DEST },
          { trustline: foo, action: "issuer" },
        ],
        trustlines: [TL, eurc, foo],
      }),
      "testnet"
    )
  );

  expect(ops.filter((o) => o.type === "pathPaymentStrictSend")).toHaveLength(1);
  const payments = ops.filter((o) => o.type === "payment") as { destination: string }[];
  expect(payments).toHaveLength(2);
  // One to the user's account, one to the issuer - not two of either.
  expect(payments.map((p) => p.destination).sort()).toEqual([TRANSFER_DEST, otherIssuer].sort());

  // Every disposition still lands before its trustline is removed.
  const lastDisposition = Math.max(
    ...ops
      .map((o, i) => (o.type === "payment" || o.type === "pathPaymentStrictSend" ? i : -1))
      .filter((i) => i >= 0)
  );
  const firstChangeTrust = ops.findIndex((o) => o.type === "changeTrust");
  expect(lastDisposition).toBeLessThan(firstChangeTrust);
});

test("assembleFusedCloseOps counts the transfer payment, so fees and batching see it", () => {
  const withTransfer = assembleFusedCloseOps(
    MASTER,
    baseInput({
      assetActions: [{ trustline: TL, action: "transfer", destination: TRANSFER_DEST }],
      trustlines: [TL],
    })
  );
  const without = assembleFusedCloseOps(MASTER, baseInput({ trustlines: [TL] }));
  expect(withTransfer.length).toBe(without.length + 1);
});
