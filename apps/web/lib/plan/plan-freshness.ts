import type { PlanResponse } from "@lumenwipe/sdk";
import type { AccountState } from "@/types/account";
import type { AssetDisposition, ClaimableBalanceSelection } from "@/types/plan";
import type { ClassicConversionFloor, TokenConversionFloor } from "@/store/demolish";
import {
  apiStepsToPlannedSteps,
  decisionPointsToClaimableBalances,
  formatStroops,
  planTransactionCountOf,
} from "@/lib/api/plan-adapters";
import { isTokenContract } from "@/lib/api/close-decisions";
import { expectedReceive, type ExpectedReceive } from "@/lib/plan/expected-receive";
import { totalFeeStroops } from "@/lib/plan/review-fees";

/** The answers a plan's material content depends on, as the store holds them. */
export interface SignatureAnswers {
  assetDispositions: Readonly<Record<string, AssetDisposition>>;
  tokenConversionFloors: Readonly<Record<string, TokenConversionFloor>>;
  classicConversionFloors: Readonly<Record<string, ClassicConversionFloor>>;
  claimableBalanceSelections: Readonly<Record<string, ClaimableBalanceSelection>>;
}

/**
 * What a reviewed plan says, reduced to the parts a user would sign differently for. Not the plan
 * hash: that covers the account's sequence, not its balance, so an incoming payment leaves it as
 * it was. Display only: never sent to the API and never part of verify().
 */
export interface PlanSignature {
  /** One key per step, in order, with its fee: a fee the user did not see is a change. */
  steps: string[];
  transactionCount: number | null;
  /** Every decision point the plan offered, sorted. */
  decisionIds: string[];
  /** The least the close delivers in stroops: the balance less the steps' fees, plus each chosen
   *  swap's stored floor (what the build is held to, so quote drift is not a change) and the
   *  claimed XLM. Null when a step's fee cannot be read. */
  netStroops: string | null;
  /** Converts with no stored floor: the least they deliver is unknown, so no comparison holds. */
  unflooredConverts: string[];
  /** Which assets and balances the account holds: answers are kept per holding. */
  holdings: string;
  /** How much of each holding there is: what a return to issuer or a transfer moves. */
  amounts: string;
  /** Who may sign for the account and what it sponsors. */
  authority: string;
}

/** A signature whose least delivered amount is known: every fee read, every convert floored. */
export type ComparableSignature = PlanSignature & { netStroops: string };

export function isComparable(signature: PlanSignature): signature is ComparableSignature {
  return signature.netStroops !== null && signature.unflooredConverts.length === 0;
}

export type PlanChange =
  | { kind: "step-count"; before: number; after: number }
  | { kind: "steps" }
  | { kind: "transaction-count"; before: number | null; after: number | null }
  /** `before` is null when the reviewed plan's own fees could not be read. */
  | { kind: "net"; before: string | null; after: string }
  | { kind: "new-decision"; count: number }
  | { kind: "amounts" }
  | { kind: "authority" };

function joined(parts: string[][]): string {
  return parts.map((part) => [...part].sort().join(",")).join("|");
}

function holdingsOf(account: AccountState): string {
  return joined([
    account.trustlines.map((t) => t.asset),
    account.claimableBalances.map((b) => b.id),
    (account.sorobanTokens?.tokens ?? []).map((t) => t.contract),
  ]);
}

function amountsOf(account: AccountState): string {
  return joined([
    account.trustlines.map((t) => `${t.asset}=${t.balance}`),
    account.claimableBalances.map((b) => `${b.id}=${b.amount}`),
    (account.sorobanTokens?.tokens ?? []).map((t) => `${t.contract}=${t.balance}`),
  ]);
}

function authorityOf(account: AccountState): string {
  const { low, med, high } = account.thresholds;
  return joined([
    account.signers.map((s) => `${s.type}:${s.key}=${s.weight}`),
    [`thresholds=${low}/${med}/${high}`],
    [
      `sponsoring=${account.numSponsoring}`,
      `sponsored=${account.numSponsored ?? 0}`,
      `sponsoredBy=${account.sponsoredBy ?? ""}`,
    ],
  ]);
}

/** The swaps' floors the user's convert answers carry, and the converts that carry none. */
function storedFloors(answers: SignatureAnswers): { stroops: bigint; unfloored: string[] } {
  let stroops = BigInt(0);
  const unfloored: string[] = [];
  for (const [asset, disposition] of Object.entries(answers.assetDispositions)) {
    if (disposition !== "convert") continue;
    const floor = isTokenContract(asset)
      ? answers.tokenConversionFloors[asset]
      : answers.classicConversionFloors[asset];
    if (floor === undefined) {
      unfloored.push(asset);
      continue;
    }
    // A null classic floor is an asset only an exit pays in: it adds nothing, as on the hero.
    if (floor.minAmountOut !== null && /^\d+$/.test(floor.minAmountOut)) {
      stroops += BigInt(floor.minAmountOut);
    }
  }
  return { stroops, unfloored: unfloored.sort() };
}

/**
 * The expected receive with its swaps counted at the floors the convert answers carry, which is
 * what the build is held to, instead of at a quote that may have moved since they were chosen.
 * The hero then never shows more than the build guarantees.
 */
export function heldToStoredFloors(
  expected: ExpectedReceive,
  answers: SignatureAnswers
): ExpectedReceive {
  const floors = storedFloors(answers).stroops;
  return {
    ...expected,
    swapStroops: floors.toString(),
    totalStroops: (
      BigInt(expected.balanceStroops) -
      BigInt(expected.feeStroops) +
      floors +
      BigInt(expected.claimStroops)
    ).toString(),
  };
}

export function signatureOf(
  plan: PlanResponse,
  account: AccountState,
  answers: SignatureAnswers
): PlanSignature {
  const steps = apiStepsToPlannedSteps(plan);
  const fee = totalFeeStroops(steps);
  // Only its balance and claim lines are read here: the swaps are counted from the stored floors.
  const base = expectedReceive({
    account,
    planFeeStroops: "0",
    relayForwardUncounted: false,
    conversions: [],
    dispositions: answers.assetDispositions,
    claims: decisionPointsToClaimableBalances(plan),
    claimSelections: answers.claimableBalanceSelections,
  });
  const floors = storedFloors(answers);
  return {
    steps: steps.map((s) =>
      [
        s.type,
        s.title,
        s.description,
        s.affectedAsset ?? "",
        s.affectedContract ?? "",
        s.operationCount,
        s.estimatedFeeLumens,
      ].join("|")
    ),
    transactionCount: planTransactionCountOf(plan),
    decisionIds: plan.decisionPoints.map((d) => d.id).sort(),
    netStroops:
      fee === null
        ? null
        : (
            BigInt(base.balanceStroops) -
            BigInt(fee) +
            floors.stroops +
            BigInt(base.claimStroops)
          ).toString(),
    unflooredConverts: floors.unfloored,
    holdings: holdingsOf(account),
    amounts: amountsOf(account),
    authority: authorityOf(account),
  };
}

/** What changed between the reviewed plan and a fresh one of the same holdings; empty when
 *  nothing material did. Holdings, floors and fees are checked before: none of them is something
 *  a new consent on /review could settle. */
export function comparePlans(reviewed: PlanSignature, fresh: ComparableSignature): PlanChange[] {
  const changes: PlanChange[] = [];
  if (reviewed.steps.length !== fresh.steps.length) {
    changes.push({ kind: "step-count", before: reviewed.steps.length, after: fresh.steps.length });
  } else if (reviewed.steps.some((key, i) => key !== fresh.steps[i])) {
    changes.push({ kind: "steps" });
  }
  if (reviewed.transactionCount !== fresh.transactionCount) {
    changes.push({
      kind: "transaction-count",
      before: reviewed.transactionCount,
      after: fresh.transactionCount,
    });
  }
  if (reviewed.netStroops !== fresh.netStroops) {
    changes.push({ kind: "net", before: reviewed.netStroops, after: fresh.netStroops });
  }
  const known = new Set(reviewed.decisionIds);
  const added = fresh.decisionIds.filter((id) => !known.has(id)).length;
  if (added > 0) changes.push({ kind: "new-decision", count: added });
  if (reviewed.amounts !== fresh.amounts) changes.push({ kind: "amounts" });
  if (reviewed.authority !== fresh.authority) changes.push({ kind: "authority" });
  return changes;
}

function xlm(stroops: string): string {
  return `about ${stroops.startsWith("-") ? "0" : formatStroops(stroops)} XLM`;
}

/** How a change is said to the user. */
export function describeChange(change: PlanChange): string {
  switch (change.kind) {
    case "step-count":
      return `The plan now has ${change.after} ${change.after === 1 ? "step" : "steps"} instead of ${change.before}.`;
    case "steps":
      return "The steps of the plan or their network fees changed.";
    case "transaction-count":
      return change.after === null || change.before === null
        ? "The number of transactions to sign changed."
        : `You will now sign about ${change.after} ${change.after === 1 ? "transaction" : "transactions"} instead of ${change.before}.`;
    case "net":
      return `The least you will receive is now ${xlm(change.after)}, where it was ${change.before === null ? "an amount that could not be estimated" : xlm(change.before)}.`;
    case "amounts":
      return "The amount of an asset or a claimable balance on the account changed.";
    case "authority":
      return "The account's signers, thresholds or sponsorships changed.";
    case "new-decision":
      return change.count === 1
        ? "The plan now includes a choice it did not have before, with its default answer."
        : `The plan now includes ${change.count} choices it did not have before, with their default answers.`;
  }
}

/** "Plan prepared ..." for an age in milliseconds. */
export function preparedAgo(ageMs: number): string {
  const minutes = Math.floor(Math.max(0, ageMs) / 60_000);
  if (minutes < 1) return "Plan prepared just now";
  if (minutes < 60) return `Plan prepared ${minutes} min ago`;
  return "Plan prepared over an hour ago";
}
