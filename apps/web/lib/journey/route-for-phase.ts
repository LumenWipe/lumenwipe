import type { DemolishPhase } from "@/types/plan";

export type CloseRoute = "analyze" | "review" | "execute" | "complete";

const ROUTE_FOR_PHASE: Record<DemolishPhase, CloseRoute> = {
  IDLE: "analyze",
  ANALYZING: "analyze",
  SIGNER_SETUP: "analyze",
  ABORTED: "analyze",
  PREFLIGHT_COMPLETE: "review",
  STEP_EXECUTING: "execute",
  STEP_CONFIRMED: "execute",
  STEP_FAILED: "execute",
  STEP_UNCONFIRMED: "execute",
  COMPLETE: "complete",
};

/** The one page of the close flow that may show a close in this phase. The review and execute
 *  guards both read it, so they can never send each other back and forth. */
export function routeForPhase(phase: DemolishPhase): CloseRoute {
  return ROUTE_FOR_PHASE[phase];
}
