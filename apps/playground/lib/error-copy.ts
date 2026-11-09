// Plain-language copy for the machine error codes the playground's routes return. A raw SDK or
// network message never reaches the user: an unknown code gets the generic line.
const NOT_CONFIGURED_COPY = "This demo is temporarily unavailable. Please try again later.";

const ERROR_COPY = new Map<string, string>(
  Object.entries({
    session_not_found: "This demo session expired. Start a new one.",
    friendbot_failed: "Could not fund the demo account. Please try again.",
    rate_limited: "Too many attempts. Please wait a moment and try again.",
    tx_failed: "A setup transaction did not go through on the test network. Please try again.",
    demolish_failed: "The close did not finish. Resume to carry on from where it stopped.",
    demolish_outcome_unknown:
      "The last close transaction is not confirmed yet. Wait a moment, then resume to check it.",
    demolish_decision_unanswerable:
      "The close stopped before signing anything: the LumenWipe API asked for a decision this demo has no answer for.",
    demolish_blocked:
      "The close stopped before signing anything: the account cannot be merged until a blocker is cleared.",
    demolish_in_progress: "The close has already started, so this cannot be done now.",
    resolution_unavailable: "This demo has no automatic fix for that blocker.",
    resolution_not_recorded: "The demo has not created what this fix acts on yet.",
    resolve_failed: "The fix did not go through on the test network. Please try again.",
    demolish_started:
      "The close has already started for this demo. Start a new one to run the setup again.",
    state_read_failed: "Could not read the demo account from the test network. Please try again.",
    not_configured: NOT_CONFIGURED_COPY,
    step_in_progress: "This step is already running. Wait for it to finish.",
    step_already_executed: "This step already ran for this demo. Start a new one to run it again.",
    invalid_step: "This demo step is not recognized. Start a new demo.",
    step_not_in_plan: "This step is not part of the demo you picked. Start a new demo.",
    step_out_of_order: "The demo steps arrived out of order. Start a new demo.",
    invalid_selection: "That combination of scenarios cannot be run. Change it and try again.",
    cleanup_failed: "The demo finished, but its leftover test accounts could not be cleared.",
    network_error: "Could not reach the playground. Check your connection and try again.",
    invalid_json: "The request could not be read. Please try again.",
  })
);

export const GENERIC_ERROR_COPY = "Something went wrong. Please try again.";

const BLOCKER_COPY = new Map<string, string>(
  Object.entries({
    sponsorship_claimable_balance_unrevocable:
      "The demo created a claimable balance for another account, so it sponsors that balance and cannot be merged until the balance is claimed.",
    sponsorship_unaffordable:
      "The demo pays the reserve of another account's entries, and that account cannot afford to take the reserve over, so the sponsorship cannot be revoked.",
  })
);

export const GENERIC_BLOCKER_COPY = "The close reported a blocker this demo has no fix for.";

/** Plain-language copy for a close blocker code the API reports. */
export function blockerCopy(code: string): string {
  return BLOCKER_COPY.get(code) ?? GENERIC_BLOCKER_COPY;
}

export function errorCopy(code: string | undefined, status?: number): string {
  const copy = code === undefined ? undefined : ERROR_COPY.get(code);
  if (copy) return copy;
  if (status === 503) return NOT_CONFIGURED_COPY;
  return GENERIC_ERROR_COPY;
}
