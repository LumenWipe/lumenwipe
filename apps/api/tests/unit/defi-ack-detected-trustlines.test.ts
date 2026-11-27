import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import type {
  AccountState,
  BlendSupplyPosition,
  DecisionAnswer,
  PlannedStep,
  Trustline,
} from "@lumenwipe/types";
import { buildAccountPlan } from "@/lib/close-api/account-plan";
import { DEFI_POSITIONS_ACK_CHOICE, defiPositionsDecisionId } from "@/lib/close-api/decisions";
import { assessDefiPositionsGate } from "@/lib/defi-positions/positions-gate";
import { DEGRADED_SOURCE_CONFIRMED } from "@/lib/defi-positions/resolve-defi-positions";
import * as readAccountModule from "@/lib/close-api/read-account";
import * as accountStateModule from "@/lib/stellar/account-state";
import * as rpcModule from "@/lib/stellar/rpc";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";
import { stubIssuance } from "./fixtures/issuance";
import { stubLedgerConfirmation } from "./fixtures/ledger-confirmation";
import { authorizationOf } from "./fixtures/trustline";
import { ALL_ON } from "@/config/kill-switches";
import { fakeRpcServer } from "../support/rpc-server";
import { latestLedger } from "../support/rpc-fixtures";

const SOURCE = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const POOL = "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF";
const USDC = "CAIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRDB3V";

const POSITION: BlendSupplyPosition = {
  protocol: "blend",
  positionType: "supply",
  contractAddress: POOL,
  assetAddress: USDC,
  bTokenAmount: "1",
  usdValue: "25.00",
};

const TRUSTLINE: Trustline = {
  asset: `USDC:${ISSUER}`,
  code: "USDC",
  issuer: ISSUER,
  balance: "0.0000000",
  ...authorizationOf(true),
};

function state(trustlines: Trustline[]): AccountState {
  const defiPositions = {
    ...emptyDefiPositionsResult(SOURCE),
    source: DEGRADED_SOURCE_CONFIRMED,
    timestamp: null,
    positions: [POSITION],
  };
  return {
    address: SOURCE,
    network: "testnet",
    sequence: "100",
    nativeBalanceLumens: "5.0000000",
    dataEntries: [],
    signers: [{ key: SOURCE, weight: 1, type: "ed25519_public_key" }],
    thresholds: { low: 0, med: 1, high: 1 },
    numSubEntries: trustlines.length,
    numSponsoring: 0,
    sponsoredBy: null,
    authImmutable: false,
    trustlines,
    openOffers: [],
    poolShares: [],
    claimableBalances: [],
    subEntryMismatch: false,
    sponsoredEntries: [],
    sponsorshipEnumerationIncomplete: false,
    defiPositions,
    defiPositionsWarnings: assessDefiPositionsGate(defiPositions, undefined, trustlines.length),
  };
}

const ACK: DecisionAnswer = {
  id: defiPositionsDecisionId(SOURCE),
  choice: DEFI_POSITIONS_ACK_CHOICE,
};

async function plan(account: AccountState, decisions: DecisionAnswer[] = []) {
  spyOn(readAccountModule, "readAccountState").mockResolvedValue(account);
  spyOn(rpcModule, "getRpcServer").mockImplementation(() =>
    fakeRpcServer({ getLatestLedger: () => Promise.resolve(latestLedger(1000)) })
  );
  spyOn(accountStateModule, "readTrustlinesOnly").mockResolvedValue({
    address: DEST,
    trustlines: [],
    memoRequired: false,
  });
  return buildAccountPlan(SOURCE, DEST, decisions, "testnet", ALL_ON, {
    preflightExits: async () => ({
      blocked: new Map(),
      simulatedFeeStroops: new Map(),
      plannedSteps: new Map(),
    }),
    fetchConversionPath: async () => ({ kind: "none", reason: "no_market" }),
  });
}

const exitContracts = (steps: PlannedStep[]): (string | undefined)[] =>
  steps.filter((s) => s.type === "EXIT_POSITIONS").map((s) => s.affectedContract);

beforeEach(() => {
  stubIssuance();
  stubLedgerConfirmation();
});
afterEach(() => mock.restore());

test("a detected position next to a trustline asks the acknowledgement and keeps its exit", async () => {
  const result = await plan(state([TRUSTLINE]));
  expect(result.blockers.map((b) => b.code)).toEqual(["defi_positions_unavailable"]);
  expect(result.decisionPoints.some((dp) => dp.id === defiPositionsDecisionId(SOURCE))).toBe(true);
  expect(exitContracts(result.steps as PlannedStep[])).toEqual([POOL]);
  expect(result.estimate.exitPayouts?.targets.map((t) => t.contract)).toEqual([POOL]);
});

test("once acknowledged, the detected position keeps its own code and its exit", async () => {
  const result = await plan(state([TRUSTLINE]), [ACK]);
  expect(result.blockers.map((b) => b.code)).toEqual(["defi_positions_unconfirmed_but_detected"]);
  expect(exitContracts(result.steps as PlannedStep[])).toEqual([POOL]);
  expect(result.estimate.exitPayouts?.targets.map((t) => t.contract)).toEqual([POOL]);
});

test("a detected position on an account with no trustlines is not asked", async () => {
  const result = await plan(state([]));
  expect(result.blockers.map((b) => b.code)).toEqual(["defi_positions_unconfirmed_but_detected"]);
  expect(result.decisionPoints.some((dp) => dp.id === defiPositionsDecisionId(SOURCE))).toBe(false);
  expect(exitContracts(result.steps as PlannedStep[])).toEqual([POOL]);
});
