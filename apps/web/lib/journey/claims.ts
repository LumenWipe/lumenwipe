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
  | "safe-to-retry"
  | "each-tx-checked"
  | "funds-safe"
  | "nothing-lost";

const DURING_SIGNING: readonly ClaimKey[] = [
  "each-tx-checked",
  "this-tx-not-sent",
  "no-new-sent",
  "may-be-sent",
  "safe-to-retry",
];

/** Which claims may be rendered in each state. Anything not listed is false in some reachable
 *  close in that state. */
export const ALLOWED_CLAIMS: Record<JourneyStateName, readonly ClaimKey[]> = {
  untouched: ["nothing-sent", "account-unchanged", "each-tx-checked"],
  planned: ["nothing-sent", "account-unchanged", "each-tx-checked"],
  reviewed: ["nothing-sent", "account-unchanged", "each-tx-checked", "confirm-not-started"],
  signing: DURING_SIGNING,
  partial: [...DURING_SIGNING, "still-open"],
  complete: ["each-tx-checked", "account-closed", "no-new-sent", "may-be-sent"],
  unknown: ["each-tx-checked", "confirm-not-started", "may-be-sent"],
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

/** How each claim reads, matched against rendered text with its whitespace collapsed. The
 *  truthfulness matrix and the source scan both read these, so a sentence that says the same
 *  thing in new words is still caught. */
export const CLAIM_PATTERNS: Record<ClaimKey, RegExp> = {
  "nothing-sent":
    /nothing (?:has been|was|is) (?:signed or )?sent|nothing (?:has been|was) signed|no transaction (?:has been|was) sent/i,
  "account-unchanged": /account is unchanged|nothing (?:on-chain|on the network) (?:has )?changed/i,
  "this-tx-not-sent": /(?:this transaction|it) was not signed or sent/i,
  "no-new-sent": /no new transaction was sent|nothing more was sent/i,
  "confirm-not-started": /this confirm did not start|this plan was not started/i,
  "may-be-sent":
    /may already be (?:confirmed|closed|on the network)|may have been (?:sent|in flight)/i,
  "account-closed":
    /account is closed|account closed|close is finished|account (?:successfully )?merged|account (?:was|has been) (?:merged|removed)/i,
  "still-open": /still open|account still exists/i,
  "safe-to-retry": /safe to retry|retrying is (?:also )?safe/i,
  "each-tx-checked":
    /before you sign each transaction|every transaction (?:above )?is verified|each transaction is (?:checked|verified)/i,
  "funds-safe": /funds are safe|funds stay safe/i,
  "nothing-lost": /nothing is lost|resume exactly where|step (?:already completed )?is skipped/i,
};

export function permittedClaims(journey: Journey): ClaimKey[] {
  return (Object.keys(CLAIM_PATTERNS) as ClaimKey[]).filter((claim) => allows(journey, claim));
}
