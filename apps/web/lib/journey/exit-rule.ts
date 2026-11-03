import type { Journey, JourneyStateName } from "./journey-state";

/** Whether leaving the close from inside the app asks first. */
export type LeaveRule = "free" | "confirm";

/** Once a close is past its review confirm, leaving it is a decision, not an accident. Entry,
 *  analyze and review, a resumed close among them, keep free navigation. */
export const LEAVE_RULE: Record<JourneyStateName, LeaveRule> = {
  untouched: "free",
  planned: "free",
  reviewed: "free",
  unknown: "free",
  signing: "confirm",
  partial: "confirm",
  complete: "free",
};

export interface ExitRule {
  leave: LeaveRule;
  /** A transaction is being signed or sent, or one was sent and its outcome is not settled. */
  inFlight: boolean;
  /** The back control on the execute page. */
  back: "analyze" | "disabled" | "leave";
  /** Closing or reloading the tab asks first. */
  warnOnUnload: boolean;
}

/** The one definition of how a close may be left, from the journey and whether a run is going. */
export function exitRuleOf(journey: Journey, signingRun: boolean): ExitRule {
  const inFlight = signingRun || journey.mayBeInFlight;
  const partial = journey.state === "partial";
  return {
    leave: LEAVE_RULE[journey.state],
    inFlight,
    back: inFlight ? "disabled" : partial ? "leave" : "analyze",
    warnOnUnload: inFlight || partial,
  };
}
