import { expect, test } from "bun:test";
import type { PlanResponse } from "@lumenwipe/sdk";
import { classicFloorFromQuote } from "@/lib/api/close-decisions";
import { recoveryRange } from "@/lib/plan/expected-receive";
import { BASE_FEE_STROOPS } from "@/config/constants";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";
import { freshAccount } from "./fixtures/fresh-plan";

const SOURCE = "GSOURCE0000000000000000000000000000000000000000000000000";
const TOKEN = "CTOKEN00000000000000000000000000000000000000000000000000";
const BALANCE = BigInt(125_000_000); // 12.5 XLM
const PLAN_FEE = BigInt(500);
const FEE = PLAN_FEE + BigInt(BASE_FEE_STROOPS);
const LOW = BALANCE - FEE;

type DecisionPoint = PlanResponse["decisionPoints"][number];

function plan(over: Partial<PlanResponse> = {}): PlanResponse {
  return {
    planHash: "h",
    status: "ready",
    steps: [],
    decisionPoints: [],
    blockers: [],
    estimate: { feeStroops: PLAN_FEE.toString(), freedReserveXlm: "3" },
    execution: { estimatedTransactionCount: null, transactions: [] },
    ...over,
  } as PlanResponse;
}

const classic = (asset: string, quote?: Record<string, string>): DecisionPoint =>
  ({
    id: `asset:${asset}`,
    type: "asset_disposition",
    subject: { kind: "classic_asset", asset, balance: "5", ...(quote ? { quote } : {}) },
    options: [{ id: "convert_to_xlm" }, { id: "transfer" }],
    default: "",
    required: true,
  }) as unknown as DecisionPoint;

const noRoute = (asset: string): DecisionPoint =>
  ({
    id: `asset:${asset}`,
    type: "asset_disposition",
    subject: { kind: "classic_asset", asset, balance: "5" },
    options: [{ id: "transfer" }],
    default: "",
    required: true,
  }) as unknown as DecisionPoint;

const token: DecisionPoint = {
  id: `asset:${TOKEN}`,
  type: "asset_disposition",
  subject: {
    kind: "soroban_token",
    contract: TOKEN,
    symbol: "TKN",
    decimals: 7,
    balance: "10000000",
    quote: { amountOut: "31000000", minAmountOut: "30000000", provider: "soroswap" },
  },
  options: [{ id: "convert_to_xlm" }, { id: "transfer" }],
  default: "",
  required: true,
} as unknown as DecisionPoint;

const claim = (
  balanceId: string,
  options: string[],
  currentlyClaimable = true,
  amount = "5.0000000"
): DecisionPoint =>
  ({
    id: `claim:${balanceId}`,
    type: "claimable_balance",
    subject: {
      kind: "claimable_balance",
      balanceId,
      asset: "native",
      amount,
      currentlyClaimable,
      predicate: { type: "unconditional" },
    },
    options: options.map((id) => ({ id })),
    default: "",
    required: true,
  }) as unknown as DecisionPoint;

const account = freshAccount(SOURCE);

test("with nothing to convert the range is one figure: the balance less the fees", () => {
  const range = recoveryRange(account, plan());
  expect(range).toEqual({
    lowStroops: LOW.toString(),
    highStroops: LOW.toString(),
    feeStroops: FEE.toString(),
    convertedAssets: 0,
    unquotedSwaps: 0,
    tokenSwaps: 0,
    unconvertibleAssets: 0,
    leavesOutDefiExits: false,
    blockers: 0,
  });
});

test("the high figure adds each conversion's floor and the claimable XLM; the low adds neither", () => {
  const range = recoveryRange(
    account,
    plan({
      decisionPoints: [
        classic("USDC:GISSUER", { estimatedReceive: "21000000", minAmountOut: "20000000" }),
        token,
        classic("NOQ:GISSUER"),
        noRoute("ART:GISSUER"),
        claim("bal1", ["claim", "forfeit"]),
        // Offered only as forfeit: the close leaves it, so it is not counted.
        claim("bal2", ["forfeit"], true, "3.0000000"),
        claim("bal3", ["claim", "forfeit"], false),
      ],
    })
  )!;
  const swaps = BigInt(classicFloorFromQuote("20000000")) + BigInt(30_000_000);
  expect(range.lowStroops).toBe(LOW.toString());
  expect(range.highStroops).toBe((LOW + swaps + BigInt(50_000_000)).toString());
  expect(range.convertedAssets).toBe(3);
  expect(range.unquotedSwaps).toBe(1);
  expect(range.tokenSwaps).toBe(1);
  expect(range.unconvertibleAssets).toBe(1);
});

test("a blocked account counts only the blockers that stop a close", () => {
  const range = recoveryRange(
    account,
    plan({
      status: "blocked",
      blockers: [
        { code: "issuer_has_supply", message: "x" },
        { code: "route_lookup_unavailable", message: "x" },
        { code: "claimable_balance_unclaimable", message: "x" },
        { code: "defi_position_left_behind", message: "x" },
      ],
    })
  )!;
  expect(range.blockers).toBe(2);
  expect(range.lowStroops).toBe(LOW.toString());
});

test("DeFi positions are flagged as not counted", () => {
  const defi = emptyDefiPositionsResult(SOURCE);
  const withPosition = freshAccount(SOURCE, {
    defiPositions: { ...defi, positions: [{} as never] },
  });
  expect(recoveryRange(withPosition, plan())!.leavesOutDefiExits).toBe(true);
});

test("a plan with no usable fee yields no figure at all", () => {
  expect(
    recoveryRange(account, plan({ estimate: { feeStroops: "", freedReserveXlm: "0" } }))
  ).toBeNull();
});

test("a balance below the fees is never shown as a negative figure", () => {
  const poor = freshAccount(SOURCE, { nativeBalanceLumens: "0.0000100" });
  const range = recoveryRange(poor, plan())!;
  expect(range.lowStroops).toBe("0");
  expect(range.highStroops).toBe("0");
});
