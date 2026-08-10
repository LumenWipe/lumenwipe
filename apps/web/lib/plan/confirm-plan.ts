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
