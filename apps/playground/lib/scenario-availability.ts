import "server-only";
import { isScenarioId, type ScenarioId } from "./scenarios";
import { EXPECTED_FEE_ACCOUNT_ENV, parseExpectedFeeAccount } from "./verify-feebump";

export const SWITCHED_OFF_REASON = "Switched off on this deployment for now.";
export const FEE_ACCOUNT_MISSING_REASON =
  "Not set up on this deployment: it has no fee account address to check the sponsored fee against.";

/**
 * Reads PLAYGROUND_DISABLED_SCENARIOS, a comma-separated list of scenario ids, so a flaky one can
 * be hidden by changing configuration instead of code. Unknown ids are ignored.
 */
export function parseDisabledScenarios(raw: string | undefined): Map<ScenarioId, string> {
  const disabled = new Map<ScenarioId, string>();
  for (const part of (raw ?? "").split(",")) {
    const id = part.trim();
    if (isScenarioId(id)) disabled.set(id, SWITCHED_OFF_REASON);
  }
  return disabled;
}

/** The scenarios a deployment cannot run: those it switched off, and the sponsored fee when it has
 *  no valid fee account address configured. */
export function unavailableFrom(env: {
  disabled: string | undefined;
  feeAccount: string | undefined;
}): Map<ScenarioId, string> {
  const unavailable = parseDisabledScenarios(env.disabled);
  if (!unavailable.has("fee-bump") && parseExpectedFeeAccount(env.feeAccount) === null) {
    unavailable.set("fee-bump", FEE_ACCOUNT_MISSING_REASON);
  }
  return unavailable;
}

/** The scenarios this deployment cannot run, read on each request. */
export function unavailableScenarios(): Map<ScenarioId, string> {
  return unavailableFrom({
    disabled: process.env.PLAYGROUND_DISABLED_SCENARIOS,
    feeAccount: process.env[EXPECTED_FEE_ACCOUNT_ENV],
  });
}
