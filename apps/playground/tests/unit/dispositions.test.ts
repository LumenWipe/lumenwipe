import { describe, expect, test } from "bun:test";
import { Asset, Keypair, Operation, xdr } from "@stellar/stellar-sdk";
import { retireRecipientOps, standingLiquidityOps } from "@/lib/mess-builders";
import {
  DISPOSITION_ASSETS,
  JUNK_OFFERS,
  PERSISTENT_ASSETS,
  STANDING_LIQUIDITY_PRICE,
  conversionFloorStroops,
  isPersistentAsset,
} from "@/lib/scenarios";

// The persistent disposition assets, the market maker's standing route to XLM for each, and the
// cleanup of the session's transfer recipient.

const issuer = Keypair.random().publicKey();
const mm = Keypair.random().publicKey();

const decode = (ops: xdr.Operation[]) => ops.map((op) => Operation.fromXDRObject(op));

describe("the catalog", () => {
  test("the persistent assets are LWDEMO and the disposition assets", () => {
    expect([...PERSISTENT_ASSETS]).toEqual(["LWDEMO", "LWCOIN", "LWGEM"]);
    for (const code of PERSISTENT_ASSETS) expect(isPersistentAsset(code)).toBe(true);
    for (const code of ["AIRDROP1", "RUGPULL", "USDC", "EURC", "native", "lwcoin"]) {
      expect(isPersistentAsset(code)).toBe(false);
    }
  });

  test("the conversion floor is what the standing offer pays, less 1%", () => {
    // 20 units at 2 per XLM is 10 XLM: 100,000,000 stroops, less 1%.
    expect(conversionFloorStroops("20")).toBe(BigInt(99_000_000));
    expect(conversionFloorStroops("8")).toBe(BigInt(39_600_000));
    for (const { amount } of DISPOSITION_ASSETS) {
      const full = (BigInt(amount) * BigInt(10_000_000)) / BigInt(STANDING_LIQUIDITY_PRICE);
      // Under the API's own minimum, which is the quote less 0.5%.
      expect(conversionFloorStroops(amount) < (full * BigInt(995)) / BigInt(1000)).toBe(true);
    }
  });

  // Another session's conversion to XLM takes the best price on the book. A junk offer that buys a
  // persistent asset with XLM at the standing price or better could be filled instead of the market
  // maker, raising this demo's balance above what the session recorded, and its close refused.
  test("a junk offer buying a persistent asset with XLM is priced above the standing offer", () => {
    const buyingPersistent = JUNK_OFFERS.filter(
      (o) => o.selling === "native" && isPersistentAsset(o.buying)
    );
    expect(buyingPersistent.length).toBeGreaterThan(0);
    for (const offer of buyingPersistent) {
      expect(Number(offer.price)).toBeGreaterThan(Number(STANDING_LIQUIDITY_PRICE));
    }
  });

  test("no junk offer trades a disposition asset", () => {
    const codes: readonly string[] = DISPOSITION_ASSETS.map((a) => a.code);
    for (const offer of JUNK_OFFERS) {
      expect(codes).not.toContain(offer.selling);
      expect(codes).not.toContain(offer.buying);
    }
  });
});

describe("standing liquidity", () => {
  const trusted = (code: string) => ({
    asset_type: "credit_alphanum12",
    asset_code: code,
    asset_issuer: issuer,
    balance: "0",
  });
  const offer = (code: string, amount: string, id = "7") => ({
    id,
    amount,
    selling: { asset_type: "native" },
    buying: { asset_code: code, asset_issuer: issuer },
  });

  test("a fresh market maker trusts and gets an offer for every persistent asset", () => {
    const ops = decode(standingLiquidityOps(issuer, 10_000, [], []).ops);
    expect(ops.map((op) => op.type)).toEqual([
      "changeTrust",
      "manageSellOffer",
      "changeTrust",
      "manageSellOffer",
      "changeTrust",
      "manageSellOffer",
    ]);
    for (const op of ops) {
      if (op.type !== "manageSellOffer") continue;
      expect(op.selling.isNative()).toBe(true);
      expect(op.buying.getIssuer()).toBe(issuer);
      expect(op.amount).toBe("1000.0000000");
      expect(op.price).toBe(STANDING_LIQUIDITY_PRICE);
      expect(op.offerId).toBe("0");
    }
  });

  test("nothing is posted when every asset is trusted and every offer has depth", () => {
    const balances = PERSISTENT_ASSETS.map(trusted);
    const offers = PERSISTENT_ASSETS.map((code) => offer(code, "100.0000000"));
    expect(standingLiquidityOps(issuer, 10_000, balances, offers)).toEqual({
      ops: [],
      unfunded: [],
    });
  });

  test("a worn offer is resized in place; an offer for another issuer does not count", () => {
    const balances = PERSISTENT_ASSETS.map(trusted);
    const offers = [
      offer("LWDEMO", "99.9999999", "11"),
      offer("LWCOIN", "500"),
      { ...offer("LWGEM", "500"), buying: { asset_code: "LWGEM", asset_issuer: mm } },
    ];
    const ops = decode(standingLiquidityOps(issuer, 10_000, balances, offers).ops);
    expect(
      ops.map((op) => (op.type === "manageSellOffer" ? [op.buying.getCode(), op.offerId] : op.type))
    ).toEqual([
      ["LWDEMO", "11"],
      ["LWGEM", "0"],
    ]);
  });

  test("the market maker keeps its own reserve, and posts nothing it cannot fund", () => {
    const balances = PERSISTENT_ASSETS.map(trusted);
    const { ops: posted, unfunded } = standingLiquidityOps(issuer, 1_200, balances, []);
    const ops = decode(posted);
    expect(unfunded).toEqual(["LWGEM"]);
    const amounts = ops.map((op) => (op.type === "manageSellOffer" ? op.amount : op.type));
    // 1,200 less the 50 kept: 1,000 for the first offer, 150 for the second, none for the third.
    expect(amounts).toEqual(["1000.0000000", "150.0000000"]);
    expect(standingLiquidityOps(issuer, 149, balances, [])).toEqual({
      ops: [],
      unfunded: [...PERSISTENT_ASSETS],
    });
  });
});

describe("retiring the transfer recipient", () => {
  test("returns what it received, removes its trustlines, then merges into the market maker", () => {
    const ops = decode(
      retireRecipientOps(issuer, mm, ["LWCOIN", "LWGEM"], [{ asset: "LWGEM", amount: "8" }])
    );
    expect(ops.map((op) => op.type)).toEqual([
      "payment",
      "changeTrust",
      "changeTrust",
      "accountMerge",
    ]);
    const [payment, coin, gem, merge] = ops;
    if (payment?.type !== "payment") throw new Error("expected a payment");
    expect([payment.destination, payment.asset.getCode(), payment.amount]).toEqual([
      issuer,
      "LWGEM",
      "8.0000000",
    ]);
    for (const [op, code] of [
      [coin, "LWCOIN"],
      [gem, "LWGEM"],
    ] as const) {
      if (op?.type !== "changeTrust" || !(op.line instanceof Asset)) {
        throw new Error("expected a trustline removal");
      }
      expect([op.line.getCode(), op.line.getIssuer(), op.limit]).toEqual([
        code,
        issuer,
        "0.0000000",
      ]);
    }
    if (merge?.type !== "accountMerge") throw new Error("expected a merge");
    expect(merge.destination).toBe(mm);
  });

  test("before the close has paid it, only the trustlines are removed", () => {
    const ops = decode(retireRecipientOps(issuer, mm, ["LWGEM"], []));
    expect(ops.map((op) => op.type)).toEqual(["changeTrust", "accountMerge"]);
  });
});
