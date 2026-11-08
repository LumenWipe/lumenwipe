import { test, expect } from "bun:test";
import {
  assetResolved,
  assetsResolved,
  classicFloorOf,
  convertFloorOf,
  convertUnfloored,
  tokenFloorOf,
} from "@/lib/plan/asset-resolution";
import type { AssetConvertibility } from "@/lib/api/plan-adapters";

// Real keypairs: isValidGAddress checks the StrKey checksum, so a fabricated 56-character
// string fails validation and would make the transfer cases pass for the wrong reason.
const ISSUER = "GBGBPPN2ACLYY4W2FGHMDTAD6CVFXX3STWYFQV6ZX7TFZYQYHAIUZMAT";
const DEST = "GBWLBY2XERGCNM5UWRIF5ZG6LM7Q7B44MHUR54BT3XVHAD5IB4HLN3XG";

const QUOTE = { estimatedReceive: "20000000", minAmountOut: "19000000" };

/** A convertible asset carries the quote the plan offers the swap with; one without is built
 *  explicitly below, as the case this file guards. */
function asset(code: string, convertible: boolean): AssetConvertibility {
  return {
    asset: `${code}:${ISSUER}`,
    code,
    balance: "10",
    convertible,
    ...(convertible ? { quote: QUOTE } : {}),
  };
}

test("an account with no balance-bearing assets is resolved", () => {
  expect(
    assetsResolved({
      conversions: [],
      balanceBearingCount: 0,
      dispositions: {},
      transferDestinations: {},
    })
  ).toBe(true);
});

test("withheld asset cards are NOT resolved, however empty the list looks", () => {
  // The bug this exists for. `[].every(...)` is true, so an empty list read as "all resolved"
  // - and the account that surfaced it held 38 balance-bearing assets whose cards were never
  // rendered, because 23 resolvable claimable-balance blockers had emptied the list. The user
  // reached "Begin execution" and was refused for decisions the UI had never shown them.
  expect(
    assetsResolved({
      conversions: [],
      balanceBearingCount: 38,
      dispositions: {},
      transferDestinations: {},
    })
  ).toBe(false);
});

test("a convertible asset is resolved by default", () => {
  expect(
    assetsResolved({
      conversions: [asset("USDC", true)],
      balanceBearingCount: 1,
      dispositions: {},
      transferDestinations: {},
    })
  ).toBe(true);
});

test("a non-convertible asset blocks until answered", () => {
  const base = {
    conversions: [asset("FOO", false)],
    balanceBearingCount: 1,
    transferDestinations: {},
  };
  expect(assetsResolved({ ...base, dispositions: {} })).toBe(false);
  expect(assetsResolved({ ...base, dispositions: { [`FOO:${ISSUER}`]: "issuer" } })).toBe(true);
});

test("a transfer needs a valid address, not just the choice", () => {
  const conversions = [asset("FOO", false)];
  const dispositions = { [`FOO:${ISSUER}`]: "transfer" as const };
  const base = { conversions, balanceBearingCount: 1, dispositions };

  expect(assetsResolved({ ...base, transferDestinations: {} })).toBe(false);
  expect(assetsResolved({ ...base, transferDestinations: { [`FOO:${ISSUER}`]: "nope" } })).toBe(
    false
  );
  expect(assetsResolved({ ...base, transferDestinations: { [`FOO:${ISSUER}`]: DEST } })).toBe(true);
});

test("a convertible asset switched to transfer also needs the address", () => {
  // The swap default must not keep vouching for an asset the user moved off it.
  const conversions = [asset("USDC", true)];
  const dispositions = { [`USDC:${ISSUER}`]: "transfer" as const };
  expect(
    assetsResolved({ conversions, balanceBearingCount: 1, dispositions, transferDestinations: {} })
  ).toBe(false);
});

test("one unresolved asset among many blocks the whole set", () => {
  expect(
    assetsResolved({
      conversions: [asset("USDC", true), asset("FOO", false)],
      balanceBearingCount: 2,
      dispositions: {},
      transferDestinations: {},
    })
  ).toBe(false);
});

// ─── Soroban tokens (#161) ────────────────────────────────────────────────────

const TOKEN_CONTRACT = "CBI7UCH5KGSVQRO5H4SUCZUTZABCITZLRHQQZTWL2TK4RZ72TAR6IHRV";
const TOKEN_QUOTE = {
  amountOut: "30000000",
  minAmountOut: "29000000",
  platform: "soroswap",
  route: [TOKEN_CONTRACT],
  provider: "soroswap" as const,
  priceImpactBps: 10,
  flags: [],
};
// The plan adapter marks a token convertible only with a readable quote, so the fixture does too.
const tokenItem = (convertible: boolean): AssetConvertibility => ({
  asset: TOKEN_CONTRACT,
  code: "XTAR",
  balance: "250",
  convertible,
  token: {
    contract: TOKEN_CONTRACT,
    symbol: "XTAR",
    decimals: 7,
    rawBalance: "2500000000",
    arrivesFromExit: false,
    ...(convertible ? { quote: TOKEN_QUOTE } : {}),
  },
});

test("a Soroban token is resolved by an explicit leave, by a transfer with a usable address, or by a convert when a route exists", () => {
  const base = {
    conversions: [tokenItem(false)],
    balanceBearingCount: 1,
    transferDestinations: {},
  };
  expect(assetsResolved({ ...base, dispositions: {} })).toBe(false);
  expect(assetsResolved({ ...base, dispositions: { [TOKEN_CONTRACT]: "leave" } })).toBe(true);
  expect(assetsResolved({ ...base, dispositions: { [TOKEN_CONTRACT]: "transfer" } })).toBe(false);
  expect(
    assetsResolved({
      ...base,
      dispositions: { [TOKEN_CONTRACT]: "transfer" },
      transferDestinations: { [TOKEN_CONTRACT]: DEST },
    })
  ).toBe(true);
  expect(
    assetsResolved({
      ...base,
      conversions: [tokenItem(true)],
      dispositions: { [TOKEN_CONTRACT]: "convert" },
    })
  ).toBe(true);
});

test("a trustline is never resolved by leave: a balance in a trustline stops the merge", () => {
  expect(
    assetsResolved({
      conversions: [asset("USDC", false)],
      balanceBearingCount: 1,
      dispositions: { [`USDC:${ISSUER}`]: "leave" },
      transferDestinations: {},
    })
  ).toBe(false);
});

// A convert with no floor is the answer the review refuses with "no minimum amount recorded"
// (refresh-plan.ts). Analyze must keep it open, or a user who changes nothing there is sent
// straight back to the same refusal.
const UNQUOTED: AssetConvertibility = {
  asset: `NOQ:${ISSUER}`,
  code: "NOQ",
  balance: "10",
  convertible: true,
};
const answers = (dispositions: Record<string, "convert" | "transfer" | "issuer">, to = {}) => ({
  dispositions,
  transferDestinations: to,
});

test("a swap the plan gives no quote for is open, chosen or taken by default", () => {
  expect(assetResolved(UNQUOTED, answers({}))).toBe(false);
  expect(assetResolved(UNQUOTED, answers({ [UNQUOTED.asset]: "convert" }))).toBe(false);
});

test("an asset with no quote is resolved by sending it or returning it instead", () => {
  expect(
    assetResolved(UNQUOTED, answers({ [UNQUOTED.asset]: "transfer" }, { [UNQUOTED.asset]: DEST }))
  ).toBe(true);
  expect(assetResolved(UNQUOTED, answers({ [UNQUOTED.asset]: "transfer" }))).toBe(false);
  expect(assetResolved(UNQUOTED, answers({ [UNQUOTED.asset]: "issuer" }))).toBe(true);
});

test("the same asset with a quote is resolved by its convert answer", () => {
  const quoted = { ...UNQUOTED, quote: QUOTE };
  expect(assetResolved(quoted, answers({}))).toBe(true);
  expect(assetResolved(quoted, answers({ [UNQUOTED.asset]: "convert" }))).toBe(true);
});

test("an asset only an exit pays in has a null floor, which counts as one", () => {
  const exit = { ...UNQUOTED, arrivesFromExit: true };
  expect(classicFloorOf(exit)).toEqual({ minAmountOut: null });
  expect(assetResolved(exit, answers({ [UNQUOTED.asset]: "convert" }))).toBe(true);
  expect(convertUnfloored(exit, "convert")).toBe(false);
});

test("a token convert whose quote is gone is open", () => {
  expect(assetResolved(tokenItem(false), answers({ [TOKEN_CONTRACT]: "convert" }))).toBe(false);
  expect(convertUnfloored(tokenItem(false), "convert")).toBe(true);
  expect(convertUnfloored(tokenItem(true), "convert")).toBe(false);
});

test("a stale convert on an asset with no route is unfloored; other answers never are", () => {
  const noRoute = asset("FOO", false);
  expect(convertUnfloored(noRoute, "convert")).toBe(true);
  expect(convertUnfloored(noRoute, undefined)).toBe(false);
  expect(convertUnfloored(UNQUOTED, undefined)).toBe(true);
  expect(convertUnfloored(UNQUOTED, "transfer")).toBe(false);
  expect(convertUnfloored(UNQUOTED, "issuer")).toBe(false);
});

test("the floors are the ones the review and verify() hold the swaps to", () => {
  // 19000000 less the 1% drift allowance.
  expect(classicFloorOf(asset("USDC", true))).toEqual({ minAmountOut: "18810000" });
  expect(classicFloorOf(UNQUOTED)).toBeUndefined();
  // A quote on an asset the plan no longer offers a swap for is not a floor.
  expect(classicFloorOf({ ...asset("USDC", false), quote: QUOTE })).toBeUndefined();
  expect(classicFloorOf(tokenItem(true))).toBeUndefined();
  expect(tokenFloorOf(tokenItem(true))).toEqual({
    minAmountOut: "29000000",
    amountOut: "30000000",
    provider: "soroswap",
  });
  expect(tokenFloorOf(tokenItem(false))).toBeUndefined();
  expect(tokenFloorOf(asset("USDC", true))).toBeUndefined();
  const quoted = tokenItem(true);
  const xbull: AssetConvertibility = {
    ...quoted,
    token: {
      ...(quoted.token as NonNullable<AssetConvertibility["token"]>),
      quote: { ...TOKEN_QUOTE, provider: "xbull", resolvedPath: ["A", "B"] },
    },
  };
  expect(convertFloorOf(xbull)).toEqual({
    minAmountOut: "29000000",
    amountOut: "30000000",
    provider: "xbull",
    resolvedPath: ["A", "B"],
  });
  expect(convertFloorOf(asset("USDC", true))).toEqual({ minAmountOut: "18810000" });
});
