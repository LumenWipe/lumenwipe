import "server-only";
import { isScenarioId, type ScenarioId } from "./scenarios";

export const SWITCHED_OFF_REASON = "Switched off on this deployment for now.";

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

/** The scenarios this deployment cannot run, read on each request. */
export function unavailableScenarios(): Map<ScenarioId, string> {
  return parseDisabledScenarios(process.env.PLAYGROUND_DISABLED_SCENARIOS);
}
