import type { DemolishPhase } from "@/types/plan";
import type { Network } from "@/config/networks";

export interface PlanNavigator {
  push: (path: string) => void;
}

/**
 * The only transition PlanView's "Begin execution" is allowed to make: PREFLIGHT_COMPLETE,
 * never STEP_EXECUTING. The review page's own confirmation is the sole caller allowed to
 * advance the phase past this gate.
 */
export function goToReview(
  setPhase: (phase: DemolishPhase) => void,
  nav: PlanNavigator,
  network: Network
): void {
  setPhase("PREFLIGHT_COMPLETE");
  nav.push(`/${network}/review`);
}

/**
 * The review gate's escape hatch: explicitly re-asserts PREFLIGHT_COMPLETE (never advances past
 * it) and returns to /analyze. Destination/memo survive the round trip because they live in the
 * store, not component state - PlanView already pre-fills its inputs from them on mount.
 */
export function goBackToAnalyze(
  setPhase: (phase: DemolishPhase) => void,
  nav: PlanNavigator,
  network: Network
): void {
  setPhase("PREFLIGHT_COMPLETE");
  nav.push(`/${network}/analyze`);
}
