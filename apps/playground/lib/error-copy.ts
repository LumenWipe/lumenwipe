// Plain-language copy for the machine error codes the playground's routes return. A raw SDK or
// network message never reaches the user: an unknown code gets the generic line.
const NOT_CONFIGURED_COPY = "This demo is temporarily unavailable. Please try again later.";

const ERROR_COPY = new Map<string, string>(
  Object.entries({
    session_not_found: "This demo session expired. Start a new one.",
    provision_failed: "Could not create the demo account on the test network. Please try again.",
    playground_refilling:
      "This demo is temporarily unavailable while its test funds are topped up. Please try again later.",
    faucet_rate_limited:
      "This demo is temporarily unavailable: the test network's faucet is limiting requests, so its test funds cannot be topped up yet. Please try again in a few hours.",
    faucet_unavailable:
      "This demo is temporarily unavailable: the test network's faucet is down, so its test funds cannot be topped up. Please try again once it is back.",
    playground_busy: "Other demos are starting right now. Please try again in a moment.",
    rate_limited: "Too many attempts. Please wait a moment and try again.",
    tx_failed: "A setup transaction did not go through on the test network. Please try again.",
    testnet_liquidity_unavailable:
      "The test network's exchange cannot sell the USDC this demo pairs in a pool right now, so nothing was signed for that step. Try again later, or start a demo without the protocol scenario.",
    testnet_lending_unavailable:
      "The test network's Blend pool has lent out nearly all of its XLM, so it cannot lend this demo any right now, and nothing was signed for that step. Try again later, or pick the supply-only Blend position.",
    demolish_failed: "The close did not finish. Resume to carry on from where it stopped.",
    demolish_outcome_unknown:
      "The last close transaction is not confirmed yet. Wait a moment, then resume to check it.",
    demolish_fee_unsponsored:
      "The LumenWipe API did not pay this close's fee, and the demo cannot pay it itself, so nothing was sent. Resume later to try again.",
    demolish_decision_unanswerable:
      "The close stopped before signing anything: the LumenWipe API asked for a decision this demo has no answer for.",
    demolish_blocked:
      "The close stopped before signing anything: the account cannot be merged until a blocker is cleared.",
    demolish_in_progress: "The close has already started, so this cannot be done now.",
    resolution_unavailable: "This demo has no automatic fix for that blocker.",
    resolution_not_recorded: "The demo has not created what this fix acts on yet.",
    resolve_failed: "The fix did not go through on the test network. Please try again.",
    allowances_read_failed:
      "Could not read the demo's allowances through the LumenWipe API. Resume to try again.",
    allowance_not_recorded: "This demo did not approve that spender, so it revokes nothing for it.",
    revoke_refused:
      "A revoke the LumenWipe API built did not pass the playground's checks, so nothing was signed.",
    revoke_failed: "A revoke did not go through on the test network. Resume to try again.",
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
