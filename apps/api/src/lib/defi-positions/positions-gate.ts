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
import { DEGRADED_SOURCE_CONFIRMED } from "./resolve-defi-positions";
import type { DefiPositionsResult, PlanBlocker } from "@lumenwipe/types";

/** Non-trapping (has a `code`, per plan-response.ts's convention): OctoPos couldn't confirm
 *  this account, but a direct on-chain sweep of every registered protocol actually ran and
 *  found nothing, and the account holds zero trustlines - which rules out every classic AMM
 *  LP position outright. Callers that can't see trustline count (or a caller not yet updated
 *  to pass it) never produce this code; see the `trustlineCount === undefined` fail-closed
 *  branch below. */
export const DEFI_POSITIONS_UNCONFIRMED_NO_TRUSTLINES_CODE =
  "defi_positions_unconfirmed_no_trustlines";

/** Non-trapping, like the code above, but for the opposite finding: the sweep completed and
 *  named a real, fully-recognized position (matched against a known contract's own code hash,
 *  read directly off the ledger). That is a stronger confirmation than an empty result, not a
 *  weaker one - the account's plan already includes an exit step for exactly what was found, so
 *  refusing to proceed here would only ever punish the position the tool can already close, not
 *  protect against one it can't. Unlike the empty-result code, this never depends on trustline
 *  count - a named position is actionable regardless of what else the account holds. */
export const DEFI_POSITIONS_UNCONFIRMED_BUT_DETECTED_CODE =
  "defi_positions_unconfirmed_but_detected";

/** The hard-blocking code: nothing here qualifies for either leniency above, so this is the
 *  genuine "we cannot tell, and the account has enough on it that we shouldn't guess" case.
 *  Exported so callers deciding whether to surface the acknowledgement below can check for it
 *  by name instead of re-deriving the same judgment `assessDefiPositionsGate` already made. */
export const DEFI_POSITIONS_UNAVAILABLE_CODE = "defi_positions_unavailable";

/** Non-trapping, like the two above, but only ever produced when the caller passes
 *  `userVerifiedNoPositions: true` - the one code on this list that depends on something outside
 *  the detection result itself. The sweep still found nothing (this never fires when
 *  `result.positions.length > 0`; that case already has its own, stronger code above), but
 *  could not rule out a protocol this tool does not yet recognize - a human confirmed manually
 *  that this account's trustlines are for other assets, not DeFi positions, and that
 *  confirmation is what downgrades the hard blocker (positions-gate.ts's own "no silent skips"
 *  invariant otherwise refuses to guess). Scoped per-address by the caller (see
 *  close-api/decisions.ts's `isDefiPositionsAcknowledged`), so it never survives being carried
 *  from one account to another. */
export const DEFI_POSITIONS_UNCONFIRMED_USER_VERIFIED_CODE =
  "defi_positions_unconfirmed_user_verified";

/** Blocker codes assessDefiPositionsGate can produce that must never trap `buildCloseTransactions`
 *  or the web's "Begin execution" gate (apps/web/lib/plan/resolvable-blockers.ts mirrors this
 *  list as plain strings, since the web never imports API modules). All three carry a `code`,
 *  which plan-response.ts's own convention already treats as "an acknowledged, non-trapping
 *  warning." */
const NON_TRAPPING_CODES = new Set([
  DEFI_POSITIONS_UNCONFIRMED_NO_TRUSTLINES_CODE,
  DEFI_POSITIONS_UNCONFIRMED_BUT_DETECTED_CODE,
  DEFI_POSITIONS_UNCONFIRMED_USER_VERIFIED_CODE,
]);

export function isNonTrappingDefiBlocker(blocker: Pick<PlanBlocker, "code">): boolean {
  return blocker.code !== undefined && NON_TRAPPING_CODES.has(blocker.code);
}

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
    code: DEFI_POSITIONS_UNAVAILABLE_CODE,
    message:
      "DeFi position data for this account could not be confirmed. This account may hold open " +
      "DeFi positions that have not been detected - verify manually on an explorer before " +
      "proceeding.",
    helpUrl: explorerUrl(result),
  };
}

/** The acknowledged counterpart to `unavailableBlocker`: same underlying uncertainty, but a
 *  human has manually verified this account's trustlines are for other assets, not DeFi
 *  positions. Still surfaced as a visible warning (the acknowledgement is an audit trail of a
 *  choice, not a reason to go quiet about it), just no longer trapping. */
function userVerifiedBlocker(result: DefiPositionsResult): PlanBlocker {
  return {
    code: DEFI_POSITIONS_UNCONFIRMED_USER_VERIFIED_CODE,
    message:
      "DeFi position data for this account could not be confirmed, but you confirmed manually " +
      "that its trustlines are for other assets, not open DeFi positions. This check only " +
      "covers protocols LumenWipe recognizes today.",
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

function confirmedButDetectedBlocker(result: DefiPositionsResult): PlanBlocker {
  const n = result.positions.length;
  return {
    code: DEFI_POSITIONS_UNCONFIRMED_BUT_DETECTED_CODE,
    message:
      `DeFi position data for this account could not be confirmed by the indexer, but a ` +
      `direct on-chain check identified ${n} position${n === 1 ? "" : "s"} (shown below), ` +
      `which will be included in this close. This check only covers protocols LumenWipe ` +
      `recognizes today - verify manually on an explorer if you want full certainty that ` +
      `nothing else is open.`,
    helpUrl: explorerUrl(result),
  };
}

/**
 * @param trustlineCount The account's trustline count, when the caller has it. Only consulted
 *   for a confirmed-empty result (positions.length === 0); `undefined` (the default) fails
 *   closed to the hard `defi_positions_unavailable` blocker there, same as before this
 *   parameter existed. A confirmed result that actually named a position never needs it - see
 *   DEFI_POSITIONS_UNCONFIRMED_BUT_DETECTED_CODE above.
 * @param userVerifiedNoPositions Whether the caller has an explicit, address-scoped
 *   acknowledgement that this account holds no DeFi positions (close-api/decisions.ts's
 *   `isDefiPositionsAcknowledged`). Only ever downgrades the hard blocker when the sweep itself
 *   also found nothing (`result.positions.length === 0`) - an acknowledgement never overrides a
 *   position the sweep actually named, confirmed or not.
 */
export function assessDefiPositionsGate(
  result: DefiPositionsResult,
  now: Date = new Date(),
  trustlineCount?: number,
  userVerifiedNoPositions = false
): PlanBlocker[] {
  const blockers: PlanBlocker[] = [];

  if (result.timestamp === null) {
    if (result.source === DEGRADED_SOURCE_CONFIRMED && result.positions.length > 0) {
      blockers.push(confirmedButDetectedBlocker(result));
    } else if (result.source === DEGRADED_SOURCE_CONFIRMED && trustlineCount === 0) {
      blockers.push(confirmedEmptyNoTrustlinesBlocker(result));
    } else if (userVerifiedNoPositions && result.positions.length === 0) {
      blockers.push(userVerifiedBlocker(result));
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
