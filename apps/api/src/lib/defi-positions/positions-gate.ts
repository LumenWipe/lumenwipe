/**
 * Gates a close on OctoPos's freshness/confidence signals, per architecture.md §7.1 and §5 and
 * the "no silent skips" invariant - the same treatment `buildPlan()` already gives a
 * `numSubEntries` mismatch: incomplete or untrustworthy data blocks with an explanation, it is
 * never silently absorbed into "this account has no DeFi positions."
 *
 * architecture.md's own description of OctoPos's meta block (`data_staleness_seconds`,
 * `last_indexed_ledger`, `partial_result`, `attribution_confidence`) does not match the real
 * vendor API - confirmed in #146 (PR #179) against OctoPos's live OpenAPI spec, which has none of
 * those fields. This gates on what `DefiPositionsResult` actually carries: `timestamp` (nullable),
 * `source`, and `unrecognizedPositions`. A missing/unparseable timestamp and an unrecognized
 * position are the real, honest stand-ins for "cannot judge freshness" and "confidence is
 * degraded" - nothing here fabricates a confidence score the vendor does not provide.
 */

import { DEFI_POSITIONS_STALENESS_THRESHOLD_SECONDS } from "@/config/constants";
import { SE_EXPLORER_BASE } from "@/config/networks";
import { DEGRADED_SOURCE_CONFIRMED_EMPTY } from "./resolve-defi-positions";
import type { DefiPositionsResult, PlanBlocker } from "@lumenwipe/types";

/** Non-trapping (has a `code`, per plan-response.ts's convention): OctoPos couldn't confirm
 *  this account, but a direct on-chain sweep of every registered protocol actually ran and
 *  found nothing, and the account holds zero trustlines - which rules out every classic AMM
 *  LP position outright. Callers that can't see trustline count (or a caller not yet updated
 *  to pass it) never produce this code; see the `trustlineCount === undefined` fail-closed
 *  branch below. */
export const DEFI_POSITIONS_UNCONFIRMED_NO_TRUSTLINES_CODE =
  "defi_positions_unconfirmed_no_trustlines";

function explorerUrl(result: DefiPositionsResult): string {
  return `${SE_EXPLORER_BASE[result.network]}/account/${result.address}`;
}

/**
 * A null timestamp means "no confirmed snapshot," regardless of why: OctoPos's real "not-tracked"
 * response always pairs with a null timestamp (confirmed via a live capture during #146), and
 * issue #149's degraded mode (an OctoPos outage, falling back to a best-effort direct read)
 * deliberately produces the same null timestamp rather than a fresh one - a best-effort read is
 * not a confirmed snapshot either. Both are "unknown," never "no positions," and both get the
 * same treatment as any other missing or unparseable timestamp.
 */
function unavailableBlocker(result: DefiPositionsResult): PlanBlocker {
  return {
    code: "defi_positions_unavailable",
    message:
      "DeFi position data for this account could not be confirmed. This account may hold open " +
      "DeFi positions that have not been detected - verify manually on an explorer before " +
      "proceeding.",
    helpUrl: explorerUrl(result),
  };
}

function confirmedEmptyNoTrustlinesBlocker(result: DefiPositionsResult): PlanBlocker {
  return {
    code: DEFI_POSITIONS_UNCONFIRMED_NO_TRUSTLINES_CODE,
    message:
      "DeFi position data for this account could not be confirmed by the indexer, but a " +
      "direct on-chain check found nothing, and this account holds no trustlines - which " +
      "rules out virtually every classic DeFi position type. Verify manually on an explorer " +
      "if you want full certainty before proceeding.",
    helpUrl: explorerUrl(result),
  };
}

/**
 * @param trustlineCount The account's trustline count, when the caller has it. `undefined`
 *   (the default) fails closed to the hard `defi_positions_unavailable` blocker, same as
 *   before this parameter existed - only a caller that explicitly knows the count can unlock
 *   the softer, non-trapping code below.
 */
export function assessDefiPositionsGate(
  result: DefiPositionsResult,
  now: Date = new Date(),
  trustlineCount?: number
): PlanBlocker[] {
  const blockers: PlanBlocker[] = [];

  if (result.timestamp === null) {
    if (result.source === DEGRADED_SOURCE_CONFIRMED_EMPTY && trustlineCount === 0) {
      blockers.push(confirmedEmptyNoTrustlinesBlocker(result));
    } else {
      blockers.push(unavailableBlocker(result));
    }
  } else {
    const timestampMs = Date.parse(result.timestamp);
    if (!Number.isFinite(timestampMs)) {
      blockers.push(unavailableBlocker(result));
    } else {
      const ageSeconds = (now.getTime() - timestampMs) / 1000;
      if (ageSeconds > DEFI_POSITIONS_STALENESS_THRESHOLD_SECONDS) {
        blockers.push({
          code: "defi_positions_stale",
          message:
            `DeFi position data for this account is ${Math.round(ageSeconds)} seconds old, ` +
            `older than the ${DEFI_POSITIONS_STALENESS_THRESHOLD_SECONDS}-second freshness ` +
            `threshold. Refresh the analysis before proceeding so the plan is built from a ` +
            `current view of this account's positions.`,
          helpUrl: explorerUrl(result),
        });
      }
    }
  }

  for (const unrecognized of result.unrecognizedPositions) {
    blockers.push({
      code: "defi_position_unrecognized",
      message:
        `A ${unrecognized.protocol} position for this account could not be safely read ` +
        `(${unrecognized.reason}). This position is not reflected in the plan - verify it ` +
        `manually on an explorer before proceeding.`,
      helpUrl: explorerUrl(result),
    });
  }

  return blockers;
}
