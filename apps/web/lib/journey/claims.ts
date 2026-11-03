import type { Journey, JourneyStateName } from "./journey-state";

/** The reassurance and success sentences the app makes about a close. */
export type ClaimKey =
  | "nothing-sent"
  | "account-unchanged"
  | "this-tx-not-sent"
  | "no-new-sent"
  | "confirm-not-started"
  | "may-be-sent"
  | "account-closed"
  | "still-open"
  | "safe-to-retry";

const DURING_SIGNING: readonly ClaimKey[] = [
  "this-tx-not-sent",
  "no-new-sent",
  "may-be-sent",
  "safe-to-retry",
];

/** Which claims may be rendered in each state. Anything not listed is false in some reachable
 *  close in that state. */
export const ALLOWED_CLAIMS: Record<JourneyStateName, readonly ClaimKey[]> = {
  untouched: ["nothing-sent", "account-unchanged"],
  planned: ["nothing-sent", "account-unchanged"],
  reviewed: ["nothing-sent", "account-unchanged", "confirm-not-started"],
  signing: DURING_SIGNING,
  partial: [...DURING_SIGNING, "still-open"],
  complete: ["account-closed", "no-new-sent"],
  unknown: ["confirm-not-started", "may-be-sent"],
};

/** A transaction that may be in flight can still land, so none of these is true while one is. */
const FALSE_WHILE_IN_FLIGHT: ReadonlySet<ClaimKey> = new Set([
  "nothing-sent",
  "account-unchanged",
  "no-new-sent",
  "safe-to-retry",
]);

export function allows(journey: Journey, claim: ClaimKey): boolean {
  if (journey.mayBeInFlight && FALSE_WHILE_IN_FLIGHT.has(claim)) return false;
  return ALLOWED_CLAIMS[journey.state].includes(claim);
}

const CLAIM_KEYS: Record<ClaimKey, true> = {
  "nothing-sent": true,
  "account-unchanged": true,
  "this-tx-not-sent": true,
  "no-new-sent": true,
  "confirm-not-started": true,
  "may-be-sent": true,
  "account-closed": true,
  "still-open": true,
  "safe-to-retry": true,
};

export function permittedClaims(journey: Journey): ClaimKey[] {
  return (Object.keys(CLAIM_KEYS) as ClaimKey[]).filter((claim) => allows(journey, claim));
}
