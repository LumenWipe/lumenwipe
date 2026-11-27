import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Address, Keypair } from "@stellar/stellar-sdk";
import type {
  AccountState,
  AssetDisposition,
  BlendSupplyPosition,
  PlanEstimate,
  PlannedStep,
} from "@lumenwipe/types";
import { buildAccountPlan } from "@/lib/close-api/account-plan";
import { planFeeEstimate } from "@/lib/close-api/plan-fee";
import { buildPlan } from "@/lib/stellar/tx-builder";
import { exitStepFeeStroops } from "@/lib/defi-exits/plan-exits";
import { tokenRoundFeeBoundStroops } from "@/lib/stellar/claim-reserve";
import {
  BASE_FEE_STROOPS,
  SOROBAN_EXIT_FEE_ESTIMATE_STROOPS,
  SOROBAN_SWAP_FEE_ESTIMATE_STROOPS,
} from "@/config/constants";
import { ALL_ON } from "@/config/kill-switches";
import { xlmToStroops } from "@/lib/utils/amounts";
import * as readAccountModule from "@/lib/close-api/read-account";
import * as accountStateModule from "@/lib/stellar/account-state";
import * as rpcModule from "@/lib/stellar/rpc";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";
import { stubIssuance } from "./fixtures/issuance";
import { stubLedgerConfirmation } from "./fixtures/ledger-confirmation";
import { fakeRpcServer } from "../support/rpc-server";
import { latestLedger } from "../support/rpc-fixtures";

const SOURCE = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const POOL = "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF";
const USDC = "CAIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRDB3V";
const EURC = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const TOKENS = [1, 2, 3, 4].map((n) => Address.contract(Buffer.alloc(32, n)).toString());
const SWAP = BigInt(SOROBAN_SWAP_FEE_ESTIMATE_STROOPS);
const EXIT = BigInt(SOROBAN_EXIT_FEE_ESTIMATE_STROOPS);

function state(over: Partial<AccountState> = {}): AccountState {
  return {
    address: SOURCE,
    network: "testnet",
    sequence: "100",
    nativeBalanceLumens: "50.0000000",
    dataEntries: [{ key: "a", value: "Yg==" }],
    signers: [{ key: SOURCE, weight: 1, type: "ed25519_public_key" }],
    thresholds: { low: 0, med: 1, high: 1 },
    numSubEntries: 1,
    numSponsoring: 0,
    sponsoredBy: null,
    authImmutable: false,
    trustlines: [],
    openOffers: [],
    poolShares: [],
    claimableBalances: [],
    subEntryMismatch: false,
    sponsoredEntries: [],
    sponsorshipEnumerationIncomplete: false,
    defiPositions: emptyDefiPositionsResult(SOURCE),
    defiPositionsWarnings: [],
    ...over,
  };
}

function withTokens(contracts: string[]): AccountState {
  return state({
    sorobanTokens: {
      tokens: contracts.map((contract) => ({
        contract,
        balance: "250",
        symbol: "XTAR",
        decimals: 7,
        sources: [],
      })),
      unreadable: [],
      coverage: [],
      eventsScanned: null,
      warnings: [],
    },
  });
}

const stepStroops = (s: PlannedStep): bigint => BigInt(xlmToStroops(s.estimatedFeeLumens));
const sumOf = (xs: bigint[]): bigint => xs.reduce((a, b) => a + b, 0n);

function expectConsistent(steps: PlannedStep[], estimate: Omit<PlanEstimate, "freedReserveXlm">) {
  const parts = estimate.feeParts;
  expect(
    BigInt(parts.classicStroops) +
      BigInt(parts.sorobanSimulatedStroops) +
      BigInt(parts.sorobanBoundStroops)
  ).toBe(BigInt(estimate.feeStroops));
  expect(sumOf(steps.map(stepStroops))).toBe(BigInt(estimate.feeStroops));
}

function planFor(s: AccountState, dispositions: Record<string, AssetDisposition>) {
  const { steps } = buildPlan(ALL_ON, s, false, false, {}, undefined, dispositions);
  return { steps, estimate: planFeeEstimate(steps, new Map()) };
}

describe("the plan's fee estimate", () => {
  test("a classic-only close pays the base fee per operation and nothing else", () => {
    const { steps, estimate } = planFor(state(), {});
    const ops = steps.reduce((n, s) => n + s.operationCount, 0);
    expect(estimate).toEqual({
      feeStroops: String(ops * BASE_FEE_STROOPS),
      feeParts: {
        classicStroops: String(ops * BASE_FEE_STROOPS),
        sorobanSimulatedStroops: "0",
        sorobanBoundStroops: "0",
      },
    });
  });

  test("each held token adds its round's bound by answer: swap, undecided, transfer, leave", () => {
    const [convert, undecided, transfer, leave] = TOKENS as [string, string, string, string];
    const s = withTokens(TOKENS);
    const classicOnly = planFor(state(), {}).estimate.feeParts.classicStroops;
    const { steps, estimate } = planFor(s, {
      [convert]: "convert",
      [transfer]: "transfer",
      [leave]: "leave",
    });
    const tokenFee = (c: string) =>
      stepStroops(steps.find((st) => st.type === "HANDLE_ASSETS" && st.affectedAsset === c)!);
    expect(tokenFee(convert)).toBe(SWAP);
    expect(tokenFee(undecided)).toBe(SWAP);
    expect(tokenFee(transfer)).toBe(EXIT);
    expect(tokenFee(leave)).toBe(0n);
    expect(estimate.feeParts).toEqual({
      classicStroops: classicOnly,
      sorobanSimulatedStroops: "0",
      sorobanBoundStroops: String(2n * SWAP + EXIT),
    });
    expectConsistent(steps, estimate);
  });

  test("the swap bound sits above the largest charge and resource fee the mainnet sample found", () => {
    expect(tokenRoundFeeBoundStroops("convert")).toBeGreaterThan(921_890n);
    expect(tokenRoundFeeBoundStroops(undefined)).toBe(tokenRoundFeeBoundStroops("convert"));
  });

  test("an exit step costs its simulated first transaction plus the bound for each other", () => {
    expect(exitStepFeeStroops(3, 4_321n)).toBe(4_321n + 2n * EXIT);
    expect(exitStepFeeStroops(3, undefined)).toBe(3n * EXIT);
  });
});

describe("the plan's fee estimate for DeFi exits", () => {
  function supply(asset: string): BlendSupplyPosition {
    return {
      protocol: "blend",
      positionType: "supply",
      contractAddress: POOL,
      assetAddress: asset,
      bTokenAmount: "1",
      usdValue: "25.00",
    };
  }

  beforeEach(() => {
    stubIssuance();
    stubLedgerConfirmation();
    spyOn(readAccountModule, "readAccountState").mockResolvedValue(
      state({
        defiPositions: {
          ...emptyDefiPositionsResult(SOURCE),
          timestamp: new Date().toISOString(),
          positions: [supply(USDC), supply(EURC)],
        },
      })
    );
    spyOn(rpcModule, "getRpcServer").mockImplementation(() =>
      fakeRpcServer({ getLatestLedger: () => Promise.resolve(latestLedger(1000)) })
    );
    spyOn(accountStateModule, "readTrustlinesOnly").mockResolvedValue({
      address: DEST,
      trustlines: [],
      memoRequired: false,
    });
  });
  afterEach(() => mock.restore());

  const exitStep = (steps: unknown[]): PlannedStep =>
    (steps as PlannedStep[]).find((s) => s.type === "EXIT_POSITIONS")!;

  test("counts the simulated envelope's fee for the first exit transaction", async () => {
    const plan = await buildAccountPlan(SOURCE, DEST, [], "testnet", ALL_ON, {
      preflightExits: async () => ({
        blocked: new Map(),
        simulatedFeeStroops: new Map([[POOL, 31_234n]]),
        plannedSteps: new Map(),
      }),
    });
    expect(stepStroops(exitStep(plan.steps))).toBe(31_234n + EXIT);
    expect(plan.estimate.feeParts.sorobanSimulatedStroops).toBe("31234");
    expect(plan.estimate.feeParts.sorobanBoundStroops).toBe(String(EXIT));
    expectConsistent(plan.steps as PlannedStep[], plan.estimate);
  });

  test("a preflight that fails or runs out of time leaves every exit transaction at the bound", async () => {
    const plan = await buildAccountPlan(SOURCE, DEST, [], "testnet", ALL_ON, {
      preflightExits: () => Promise.reject(new Error("exit preflight exceeded 10000 ms")),
    });
    expect(stepStroops(exitStep(plan.steps))).toBe(2n * EXIT);
    expect(plan.estimate.feeParts.sorobanSimulatedStroops).toBe("0");
    expect(plan.estimate.feeParts.sorobanBoundStroops).toBe(String(2n * EXIT));
    expectConsistent(plan.steps as PlannedStep[], plan.estimate);
  });
});
