import { spyOn } from "bun:test";
import type { PlanResponse } from "@lumenwipe/sdk";
import * as analyzeClient from "@/lib/api/analyze-client";
import * as closeClient from "@/lib/api/close-client";
import { signatureOf } from "@/lib/plan/plan-freshness";
import { useDemolishStore } from "@/store/demolish";
import type { AccountState } from "@/types/account";
import type { PlannedStep } from "@/types/plan";
import { emptyDefiPositionsResult } from "./defi-positions";

/** The reviewed account as a confirm-time refresh reads it again. */
export function freshAccount(address: string, overrides: Partial<AccountState> = {}): AccountState {
  return {
    address,
    network: "testnet",
    sequence: "1",
    nativeBalanceLumens: "12.5000000",
    dataEntries: [],
    signers: [],
    thresholds: { low: 0, med: 0, high: 0 },
    numSubEntries: 0,
    numSponsoring: 0,
    sponsoredEntries: [],
    sponsorshipEnumerationIncomplete: false,
    sponsoredBy: null,
    authImmutable: false,
    trustlines: [],
    openOffers: [],
    poolShares: [],
    claimableBalances: [],
    subEntryMismatch: false,
    defiPositions: emptyDefiPositionsResult(address),
    defiPositionsWarnings: [],
    ...overrides,
  };
}

/** A ready plan of these steps, as the API returns it. */
export function freshPlan(
  steps: readonly PlannedStep[],
  overrides: Partial<PlanResponse> = {}
): PlanResponse {
  return {
    planHash: "f".repeat(64),
    status: "ready",
    steps: steps.map(({ index, type, title, description, operationCount, estimatedFeeLumens }) => ({
      index,
      type,
      title,
      description,
      operationCount,
      estimatedFeeLumens,
    })),
    decisionPoints: [],
    blockers: [],
    estimate: { feeStroops: "100", freedReserveXlm: "1.0000000" },
    execution: { estimatedTransactionCount: steps.length, transactions: [] },
    ...overrides,
  } as unknown as PlanResponse;
}

/**
 * Makes the store's installed plan one that was reviewed from `account` and `plan`, and answers
 * the confirm-time refresh with the same two: nothing material changed.
 */
export function stubUnchangedRefresh(
  account?: AccountState,
  plan?: PlanResponse
): { readAccount: ReturnType<typeof spyOn>; fetchClosePlan: ReturnType<typeof spyOn> } {
  const state = useDemolishStore.getState();
  const reviewedAccount = account ?? freshAccount(state.sourceAddress ?? "G");
  const reviewedPlan = plan ?? freshPlan(state.executionPlan);
  useDemolishStore.setState({
    planSignature: signatureOf(reviewedPlan, reviewedAccount, state),
    planPreparedAt: Date.now(),
  });
  return {
    readAccount: spyOn(analyzeClient, "readAccount").mockResolvedValue(reviewedAccount),
    fetchClosePlan: spyOn(closeClient, "fetchClosePlan").mockResolvedValue(reviewedPlan),
  };
}
