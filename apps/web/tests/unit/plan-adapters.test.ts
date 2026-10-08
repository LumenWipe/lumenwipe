import { test, expect } from "bun:test";
import { decisionPointsToClaimableBalances } from "@/lib/api/plan-adapters";
import type { PlanResponse } from "@/types/close-api";

function plan(decisionPoints: PlanResponse["decisionPoints"]): PlanResponse {
  return {
    planHash: "hash",
    status: "needs_decisions",
    steps: [],
    decisionPoints,
    blockers: [],
    estimate: { feeStroops: "0", freedReserveXlm: "0" },
    execution: { estimatedTransactionCount: 0, transactions: [] },
  };
}

test("decisionPointsToClaimableBalances › maps a currently-claimable point", () => {
  const result = decisionPointsToClaimableBalances(
    plan([
      {
        id: "claim:bal1",
        type: "claimable_balance",
        subject: {
          kind: "claimable_balance",
          balanceId: "bal1",
          asset: "native",
          amount: "5.0000000",
          currentlyClaimable: true,
          predicate: { type: "unconditional" },
        },
        options: [{ id: "claim", recommended: true }, { id: "forfeit" }],
        default: "claim",
        required: true,
      },
    ])
  );
  expect(result).toEqual([
    {
      balanceId: "bal1",
      asset: "native",
      code: "XLM",
      amount: "5.0000000",
      currentlyClaimable: true,
      predicate: { type: "unconditional" },
    },
  ]);
});

test("decisionPointsToClaimableBalances › maps a non-native, not-currently-claimable point", () => {
  const result = decisionPointsToClaimableBalances(
    plan([
      {
        id: "claim:bal2",
        type: "claimable_balance",
        subject: {
          kind: "claimable_balance",
          balanceId: "bal2",
          asset: "USDC:GISSUER",
          amount: "10.0000000",
          currentlyClaimable: false,
          predicate: { type: "before_absolute_time", absBeforeEpoch: "999" },
        },
        options: [{ id: "add_trustline_then_claim" }, { id: "forfeit" }],
        default: "",
        required: true,
      },
    ])
  );
  expect(result).toEqual([
    {
      balanceId: "bal2",
      asset: "USDC:GISSUER",
      code: "USDC",
      amount: "10.0000000",
      currentlyClaimable: false,
      predicate: { type: "before_absolute_time", absBeforeEpoch: "999" },
    },
  ]);
});

test("decisionPointsToClaimableBalances › missing predicate defaults to unconditional", () => {
  const result = decisionPointsToClaimableBalances(
    plan([
      {
        id: "claim:bal3",
        type: "claimable_balance",
        subject: {
          kind: "claimable_balance",
          balanceId: "bal3",
          asset: "native",
          amount: "1.0000000",
          currentlyClaimable: true,
        },
        options: [{ id: "claim" }, { id: "forfeit" }],
        default: "claim",
        required: true,
      },
    ])
  );
  expect(result[0].predicate).toEqual({ type: "unconditional" });
});

test("decisionPointsToClaimableBalances › ignores non-claimable_balance decision points", () => {
  const result = decisionPointsToClaimableBalances(
    plan([
      {
        id: "asset:USDC-GISSUER",
        type: "asset_disposition",
        subject: { asset: "USDC:GISSUER", balance: "10", convertible: true },
        options: [{ id: "convert_to_xlm" }],
        default: "convert_to_xlm",
        required: true,
      },
    ])
  );
  expect(result).toEqual([]);
});

test("decisionPointsToClaimableBalances › no decision points → empty list", () => {
  expect(decisionPointsToClaimableBalances(plan([]))).toEqual([]);
});

// ─── Soroban tokens (#161) ────────────────────────────────────────────────────

import {
  apiStepsToPlannedSteps,
  decisionPointsToConversions,
  formatStroops,
  formatTokenBalance,
} from "@/lib/api/plan-adapters";

const TOKEN = "CBI7UCH5KGSVQRO5H4SUCZUTZABCITZLRHQQZTWL2TK4RZ72TAR6IHRV";

test("decisionPointsToConversions › a Soroban token point becomes a token item with its raw balance kept", () => {
  const items = decisionPointsToConversions(
    plan([
      {
        id: `token:${TOKEN}`,
        type: "asset_disposition",
        subject: {
          kind: "soroban_token",
          contract: TOKEN,
          symbol: "XTAR",
          decimals: 7,
          balance: "2500000000",
          convertible: false,
        },
        options: [{ id: "transfer_to_account" }, { id: "acknowledge_residue" }],
        default: "transfer_to_account",
        required: true,
      },
      {
        id: "asset:USDC-GISSUER",
        type: "asset_disposition",
        subject: { asset: "USDC:GISSUER", balance: "12.5000000" },
        options: [{ id: "convert_to_xlm" }],
        default: "convert_to_xlm",
        required: true,
      },
    ])
  );
  expect(items).toEqual([
    {
      asset: TOKEN,
      code: "XTAR",
      balance: "250",
      convertible: false,
      token: {
        contract: TOKEN,
        symbol: "XTAR",
        decimals: 7,
        rawBalance: "2500000000",
        arrivesFromExit: false,
      },
    },
    {
      asset: "USDC:GISSUER",
      code: "USDC",
      balance: "12.5000000",
      convertible: true,
      arrivesFromExit: false,
    },
  ]);
});

test("decisionPointsToConversions › a token without metadata is named by its contract and shown in raw units", () => {
  const [item] = decisionPointsToConversions(
    plan([
      {
        id: `token:${TOKEN}`,
        type: "asset_disposition",
        subject: {
          kind: "soroban_token",
          contract: TOKEN,
          symbol: null,
          decimals: null,
          balance: "42",
        },
        options: [{ id: "transfer_to_account" }, { id: "acknowledge_residue" }],
        default: "transfer_to_account",
        required: true,
      },
    ])
  );
  expect(item).toMatchObject({ code: "CBI7…IHRV", balance: "42 base units", convertible: false });
});

test("formatTokenBalance › decimals place the point, trailing zeros drop, tiny amounts keep their leading zero", () => {
  expect(formatTokenBalance("2500000000", 7)).toBe("250");
  expect(formatTokenBalance("1", 7)).toBe("0.0000001");
  expect(formatTokenBalance("1000000000000000000", 18)).toBe("1");
  expect(formatTokenBalance("123456789012345678", 18)).toBe("0.123456789012345678");
  expect(formatTokenBalance("7", 0)).toBe("7");
  expect(formatTokenBalance("7", null)).toBe("7 base units");
  expect(formatTokenBalance("abc", 7)).toBe("abc");
});

test("formatTokenBalance › an absurd decimals figure falls back to raw units instead of throwing", () => {
  expect(formatTokenBalance("7", 4294967295)).toBe("7 base units");
  expect(formatTokenBalance("7", -1)).toBe("7 base units");
});

test("decisionPointsToConversions › a token an exit pays out later carries arrivesFromExit", () => {
  const [item] = decisionPointsToConversions(
    plan([
      {
        id: `token:${TOKEN}`,
        type: "asset_disposition",
        subject: {
          kind: "soroban_token",
          contract: TOKEN,
          symbol: "XTAR",
          decimals: 7,
          balance: "0",
          arrivesFromExit: true,
        },
        options: [{ id: "transfer_to_account" }, { id: "acknowledge_residue" }],
        default: "transfer_to_account",
        required: true,
      },
    ])
  );
  expect(item!.token).toMatchObject({ arrivesFromExit: true, rawBalance: "0" });
});

test("decisionPointsToConversions › a convertible token carries its quote; a malformed quote leaves it not convertible - there is no floor to submit", () => {
  const point = (quote: unknown) => ({
    id: `token:${TOKEN}`,
    type: "asset_disposition" as const,
    subject: {
      kind: "soroban_token",
      contract: TOKEN,
      symbol: "XTAR",
      decimals: 7,
      balance: "2500000000",
      convertible: true,
      quote,
    },
    options: [
      { id: "convert_to_xlm" },
      { id: "transfer_to_account" },
      { id: "acknowledge_residue" },
    ],
    default: "convert_to_xlm",
    required: true,
  });
  const [ok] = decisionPointsToConversions(
    plan([
      point({
        amountOut: "5249630",
        minAmountOut: "5223381",
        platform: "aggregator",
        route: ["soroswap"],
        provider: "soroswap",
      }),
    ])
  );
  expect(ok!.token?.quote).toEqual({
    amountOut: "5249630",
    minAmountOut: "5223381",
    platform: "aggregator",
    route: ["soroswap"],
    provider: "soroswap",
  });
  // The API's own `convertible` flag says a route exists, but without a floor the browser could
  // never submit a valid convert answer - so a malformed quote must not leave the option offered.
  const [bad] = decisionPointsToConversions(plan([point({ amountOut: "x", minAmountOut: "0" })]));
  expect(bad!.convertible).toBe(false);
  expect(bad!.token?.quote).toBeUndefined();
  // No `provider` at all: the server always sets one (Task 6/7), so a quote without it is not a
  // shape this adapter can trust - the option is not offered rather than defaulted to a provider
  // the user was never actually quoted through.
  const [noProvider] = decisionPointsToConversions(
    plan([point({ amountOut: "5249630", minAmountOut: "5223381", platform: "aggregator" })])
  );
  expect(noProvider!.token?.quote).toBeUndefined();
  expect(formatStroops("5223381")).toBe("0.5223381");
  expect(formatStroops("520000000")).toBe("52");
});

test("decisionPointsToConversions › an xBull quote's resolvedPath is kept only when every hop is a well-formed contract id", () => {
  const XLM = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
  const point = (quote: unknown) => ({
    id: `token:${TOKEN}`,
    type: "asset_disposition" as const,
    subject: {
      kind: "soroban_token",
      contract: TOKEN,
      symbol: "XTAR",
      decimals: 7,
      balance: "2500000000",
      convertible: true,
      quote,
    },
    options: [
      { id: "convert_to_xlm" },
      { id: "transfer_to_account" },
      { id: "acknowledge_residue" },
    ],
    default: "convert_to_xlm",
    required: true,
  });
  const [good] = decisionPointsToConversions(
    plan([
      point({
        amountOut: "5100000",
        minAmountOut: "5074650",
        platform: "router",
        route: ["xbull"],
        provider: "xbull",
        resolvedPath: [TOKEN, XLM],
      }),
    ])
  );
  expect(good!.token?.quote?.resolvedPath).toEqual([TOKEN, XLM]);
  // Not a list of strings at all: dropped, not passed through as-is.
  const [notAList] = decisionPointsToConversions(
    plan([
      point({
        amountOut: "5100000",
        minAmountOut: "5074650",
        provider: "xbull",
        resolvedPath: "not-a-list",
      }),
    ])
  );
  expect(notAList!.token?.quote?.resolvedPath).toBeUndefined();
  // One malformed hop poisons the whole path rather than silently shortening it - a route
  // missing a hop is worse than no route at all.
  const [oneBadHop] = decisionPointsToConversions(
    plan([
      point({
        amountOut: "5100000",
        minAmountOut: "5074650",
        provider: "xbull",
        resolvedPath: [TOKEN, "not-a-contract-id"],
      }),
    ])
  );
  expect(oneBadHop!.token?.quote?.resolvedPath).toBeUndefined();
  // A Soroswap win never carries a resolvedPath at all - verify() only needs one for xBull's
  // strict_send shape.
  const [soroswapWin] = decisionPointsToConversions(
    plan([
      point({
        amountOut: "5249630",
        minAmountOut: "5223381",
        provider: "soroswap",
      }),
    ])
  );
  expect(soroswapWin!.token?.quote?.resolvedPath).toBeUndefined();
});

/**
 * The API has always sent `affectedContract` on an exit step; the adapter dropped it, so the
 * receipt's "DeFi positions exited" group - which matches confirmed exits to detected positions
 * by contract - could never render. A close that unwound three positions said nothing about them.
 */
test("apiStepsToPlannedSteps keeps the contract an exit step leaves", () => {
  const POOL = "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF";
  const steps = apiStepsToPlannedSteps({
    ...plan([]),
    steps: [
      {
        index: 0,
        type: "EXIT_POSITIONS",
        title: "Exit Blend CCEB…4HGF",
        description: "Leave Blend.",
        operationCount: 1,
        estimatedFeeLumens: "0.0010000",
        affectedContract: POOL,
      },
    ],
  });

  expect(steps[0]!.affectedContract).toBe(POOL);
});
