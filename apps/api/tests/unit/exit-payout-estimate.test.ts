import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Asset, Keypair, Networks } from "@stellar/stellar-sdk";
import type { AccountState, PhoenixLpPosition } from "@lumenwipe/types";
import * as readAccount from "@/lib/close-api/read-account";
import { buildAccountPlan } from "@/lib/close-api/account-plan";
import { estimateExitPayouts, exitPayoutOf } from "@/lib/close-api/exit-payouts";
import type { ExitStep } from "@/lib/defi-exits/adapter";
import type { fetchConversionPath } from "@/lib/stellar/path-finding";
import * as rpcModule from "@/lib/stellar/rpc";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";
import { authorizationOf } from "./fixtures/trustline";
import { stubIssuance } from "./fixtures/issuance";
import { stubLedgerConfirmation } from "./fixtures/ledger-confirmation";
import { ALL_ON } from "@/config/kill-switches";
import { fakeRpcServer } from "../support/rpc-server";
import { latestLedger } from "../support/rpc-fixtures";

const SOURCE = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const USDC = `USDC:${ISSUER}`;
const XLM_SAC = Asset.native().contractId(Networks.TESTNET);
const USDC_SAC = new Asset("USDC", ISSUER).contractId(Networks.TESTNET);
const SOROBAN_TOKEN = "CBACKSTOPLPTOKENXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const POOL = "CPHOENIXPOOLXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

function state(usdcBalance = "0.0386000"): AccountState {
  return {
    address: SOURCE,
    network: "testnet",
    sequence: "100",
    nativeBalanceLumens: "18.2356000",
    dataEntries: [],
    signers: [{ key: SOURCE, weight: 1, type: "ed25519_public_key" }],
    thresholds: { low: 0, med: 1, high: 1 },
    numSubEntries: 1,
    numSponsoring: 0,
    sponsoredBy: null,
    authImmutable: false,
    trustlines: [
      {
        asset: USDC,
        balance: usdcBalance,
        ...authorizationOf(true),
        issuer: ISSUER,
        code: "USDC",
        limit: "1000",
      },
    ],
    openOffers: [],
    poolShares: [],
    claimableBalances: [],
    subEntryMismatch: false,
    sponsoredEntries: [],
    sponsorshipEnumerationIncomplete: false,
    defiPositions: emptyDefiPositionsResult(SOURCE),
    defiPositionsWarnings: [],
  };
}

function step(kind: ExitStep["kind"], fields: Partial<ExitStep> = {}): ExitStep {
  return {
    kind,
    contract: POOL,
    function: "f",
    asset: XLM_SAC,
    amount: "0",
    ceiling: "0",
    minReceived: [],
    description: kind,
    ...fields,
  };
}

const lpWithdraw = step("lp_withdraw", {
  amount: "20491361",
  ceiling: "20491361",
  minReceived: [
    { asset: XLM_SAC, amount: "57213000" },
    { asset: USDC_SAC, amount: "7303000" },
  ],
});

describe("exitPayoutOf", () => {
  const account = state();

  test("an LP withdrawal pays in its floors, by classic asset", () => {
    expect(exitPayoutOf([lpWithdraw], account)).toEqual([
      { asset: "native", stroops: "57213000" },
      { asset: USDC, stroops: "7303000" },
    ]);
  });

  test("a lending exit pays in what it withdraws less what it repays", () => {
    const steps = [
      step("repay", { asset: USDC_SAC, amount: "2000000", ceiling: "5000000" }),
      step("withdraw_collateral", { asset: XLM_SAC, amount: "101000000", ceiling: "100000000" }),
      step("withdraw", { asset: USDC_SAC, amount: "5050000", ceiling: "5000000" }),
      step("claim", { asset: SOROBAN_TOKEN, amount: "9", ceiling: "9" }),
    ];
    expect(exitPayoutOf(steps, account)).toEqual([
      { asset: USDC, stroops: "3000000" },
      { asset: "native", stroops: "100000000" },
    ]);
  });

  test("a repay larger than the withdrawal leaves a negative part", () => {
    const steps = [
      step("repay", { asset: XLM_SAC, amount: "30000000", ceiling: "90000000" }),
      step("withdraw", { asset: XLM_SAC, amount: "10100000", ceiling: "10000000" }),
    ];
    expect(exitPayoutOf(steps, account)).toEqual([{ asset: "native", stroops: "-20000000" }]);
  });

  test("a token no classic asset stands for is not counted when received", () => {
    const steps = [step("withdraw", { asset: SOROBAN_TOKEN, amount: "5", ceiling: "5" })];
    expect(exitPayoutOf(steps, account)).toEqual([]);
  });

  test("cannot be worked out when a token no classic asset stands for is spent", () => {
    const steps = [step("repay", { asset: SOROBAN_TOKEN, amount: "5", ceiling: "5" })];
    expect(exitPayoutOf(steps, account)).toBeNull();
  });

  test("cannot be worked out from an unbond, whose withdrawal is only planned once it lands", () => {
    expect(exitPayoutOf([step("unstake", { amount: "10", ceiling: "10" })], account)).toBeNull();
  });
});

describe("estimateExitPayouts", () => {
  const targets = [{ protocol: "phoenix" as const, contract: POOL }];

  test("quotes an asset at what it holds plus what the exits pay in", async () => {
    const asked: [string, string][] = [];
    const estimate = await estimateExitPayouts({
      account: state(),
      targets,
      plannedSteps: new Map([[POOL, [lpWithdraw]]]),
      heldStroops: new Map([[USDC, 386_000n]]),
      convertible: () => true,
      quote: async (asset, amount) => {
        asked.push([asset, amount]);
        return { estimatedReceive: "50000000", minAmountOut: "49000000" };
      },
    });
    expect(asked).toEqual([[USDC, "0.7689000"]]);
    expect(estimate.quotes).toEqual({
      [USDC]: { estimatedReceive: "50000000", minAmountOut: "49000000" },
    });
    expect(estimate.targets[0]!.parts).toHaveLength(2);
  });

  test("a target the preflight did not plan is not computed", async () => {
    const estimate = await estimateExitPayouts({
      account: state(),
      targets,
      plannedSteps: new Map(),
      heldStroops: new Map(),
      convertible: () => true,
      quote: async () => null,
    });
    expect(estimate).toEqual({ targets: [{ ...targets[0]!, parts: null }], quotes: {} });
  });

  test("an asset with no route, or no quote, carries none", async () => {
    for (const [convertible, quoted] of [
      [false, true],
      [true, false],
    ] as const) {
      const estimate = await estimateExitPayouts({
        account: state(),
        targets,
        plannedSteps: new Map([[POOL, [lpWithdraw]]]),
        heldStroops: new Map(),
        convertible: () => convertible,
        quote: async () => (quoted ? { estimatedReceive: "1", minAmountOut: "1" } : null),
      });
      expect(estimate.quotes).toEqual({});
    }
  });

  test("an asset the exits spend all of is worth nothing", async () => {
    const estimate = await estimateExitPayouts({
      account: state(),
      targets,
      plannedSteps: new Map([[POOL, [step("repay", { asset: USDC_SAC, amount: "386000" })]]]),
      heldStroops: new Map([[USDC, 386_000n]]),
      convertible: () => true,
      quote: async () => {
        throw new Error("not asked");
      },
    });
    expect(estimate.quotes).toEqual({ [USDC]: { estimatedReceive: "0", minAmountOut: "0" } });
  });
});

describe("the plan's exit payouts", () => {
  beforeEach(() => {
    stubIssuance();
    stubLedgerConfirmation();
    spyOn(rpcModule, "getRpcServer").mockImplementation(() =>
      fakeRpcServer({ getLatestLedger: () => Promise.resolve(latestLedger(1000)) })
    );
    const position: PhoenixLpPosition = {
      protocol: "phoenix",
      positionType: "lp",
      contractAddress: POOL,
      shareAmount: "20491361",
      usdValue: null,
    };
    spyOn(readAccount, "readAccountState").mockResolvedValue({
      ...state(),
      defiPositions: { ...emptyDefiPositionsResult(SOURCE), positions: [position] },
    });
  });
  afterEach(() => mock.restore());

  const linearPath: typeof fetchConversionPath = async (fromAsset, amount) => ({
    kind: "route",
    path: {
      fromAsset,
      toAsset: "native",
      path: [],
      estimatedReceive: (Number(amount) * 6.5).toFixed(7),
      destMin: (Number(amount) * 6.4).toFixed(7),
    },
  });

  async function plan(plannedSteps: Map<string, ExitStep[]>) {
    return buildAccountPlan(SOURCE, null, [], "testnet", ALL_ON, {
      fetchConversionPath: linearPath,
      preflightExits: async () => ({
        blocked: new Map(),
        simulatedFeeStroops: new Map(),
        plannedSteps,
      }),
    });
  }

  test("reports each exit's parts and a quote for the amount held after it", async () => {
    const { estimate } = await plan(new Map([[POOL, [lpWithdraw]]]));
    expect(estimate.exitPayouts).toEqual({
      targets: [
        {
          protocol: "phoenix",
          contract: POOL,
          parts: [
            { asset: "native", stroops: "57213000" },
            { asset: USDC, stroops: "7303000" },
          ],
        },
      ],
      quotes: { [USDC]: { estimatedReceive: "49978500", minAmountOut: "49209600" } },
    });
  });

  test("leaves every convert floor and the plan hash as they are without exit payouts", async () => {
    const withPayouts = await plan(new Map([[POOL, [lpWithdraw]]]));
    const without = await plan(new Map());
    expect(without.estimate.exitPayouts?.targets[0]!.parts).toBeNull();
    expect(withPayouts.planHash).toBe(without.planHash);
    expect(withPayouts.decisionPoints).toEqual(without.decisionPoints);
    const usdc = withPayouts.decisionPoints.find((d) => d.subject.asset === USDC);
    expect(usdc?.subject.quote).toEqual({ estimatedReceive: "2509000", minAmountOut: "2470400" });
  });
});
