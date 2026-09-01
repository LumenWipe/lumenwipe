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
import type { DefiPositionsResult, PlanBlocker } from "@lumenwipe/types";

function explorerUrl(result: DefiPositionsResult): string {
  return `${SE_EXPLORER_BASE[result.network]}/account/${result.address}`;
}

/**
 * OctoPos's real "not-tracked" response always pairs with a null timestamp (confirmed via a live
 * capture during #146) - there is no snapshot to judge freshness against, so this is not "no
 * positions," it is "unknown." Treated the same as any other missing or unparseable timestamp.
 */
function unavailableBlocker(result: DefiPositionsResult): PlanBlocker {
  return {
    code: "defi_positions_unavailable",
    message:
      "DeFi position data for this account could not be confirmed (OctoPos has no snapshot for " +
      "it yet). This account may hold open DeFi positions that have not been detected - verify " +
      "manually on an explorer before proceeding.",
    helpUrl: explorerUrl(result),
  };
}

export function assessDefiPositionsGate(
  result: DefiPositionsResult,
  now: Date = new Date()
): PlanBlocker[] {
  const blockers: PlanBlocker[] = [];

  if (result.timestamp === null) {
    blockers.push(unavailableBlocker(result));
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
        `OctoPos reported a ${unrecognized.protocol} position for this account that could not ` +
        `be safely read (${unrecognized.reason}). This position is not reflected in the plan - ` +
        `verify it manually on an explorer before proceeding.`,
      helpUrl: explorerUrl(result),
    });
  }

  return blockers;
}
