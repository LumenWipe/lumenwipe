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
  | "sent-only-when-signed"
  | "more-sent-only-when-signed"
  | "resume-after-stop"
  | "funds-safe"
  | "nothing-lost"
  | "can-resume"
  | "recorded-progress"
  | "key-stays-in-browser"
  | "receipt-saved"
  | "amount-received"
  | "same-browser-signing";

const DURING_SIGNING: readonly ClaimKey[] = [
  "each-tx-checked",
  "this-tx-not-sent",
  "no-new-sent",
  "may-be-sent",
  "safe-to-retry",
];

/** True in every state, whatever the close has done: a secret key entered on the signing screen is
 *  held in memory and is never stored or sent, and every signature is given in this browser. */
const IN_EVERY_STATE: readonly ClaimKey[] = ["key-stays-in-browser", "same-browser-signing"];

/** Which claims may be rendered in each state. Anything not listed is false in some reachable
 *  close in that state. */
export const ALLOWED_CLAIMS: Record<JourneyStateName, readonly ClaimKey[]> = {
  untouched: [
    ...IN_EVERY_STATE,
    "nothing-sent",
    "account-unchanged",
    "each-tx-checked",
    "sent-only-when-signed",
  ],
  planned: [
    ...IN_EVERY_STATE,
    "nothing-sent",
    "account-unchanged",
    "each-tx-checked",
    "sent-only-when-signed",
  ],
  reviewed: [
    ...IN_EVERY_STATE,
    "nothing-sent",
    "account-unchanged",
    "each-tx-checked",
    "confirm-not-started",
    "sent-only-when-signed",
    "more-sent-only-when-signed",
    "resume-after-stop",
  ],
  // Past the review confirm a close always has a saved record: run() sends nothing without one.
  // A review reached with a transaction in flight is here too, so its "nothing more" is allowed.
  signing: [
    ...IN_EVERY_STATE,
    ...DURING_SIGNING,
    "more-sent-only-when-signed",
    "resume-after-stop",
    "can-resume",
    "recorded-progress",
  ],
  // "receipt-saved" is allowed only where a receipt is written, and is shown only once its write
  // succeeded: the state allows it, the write outcome decides it.
  partial: [
    ...IN_EVERY_STATE,
    ...DURING_SIGNING,
    "still-open",
    "can-resume",
    "recorded-progress",
    "receipt-saved",
  ],
  complete: [
    ...IN_EVERY_STATE,
    "each-tx-checked",
    "account-closed",
    "no-new-sent",
    "may-be-sent",
    "receipt-saved",
    "amount-received",
  ],
  // Earlier transactions may already have been sent: only "nothing more" is true here.
  unknown: [
    ...IN_EVERY_STATE,
    "each-tx-checked",
    "more-sent-only-when-signed",
    "resume-after-stop",
    "confirm-not-started",
    "may-be-sent",
    "can-resume",
    "recorded-progress",
  ],
};

/** A transaction that may be in flight can still land, so none of these is true while one is. */
const FALSE_WHILE_IN_FLIGHT: ReadonlySet<ClaimKey> = new Set([
  "nothing-sent",
  "account-unchanged",
  "no-new-sent",
  "safe-to-retry",
  "sent-only-when-signed",
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
    /nothing (?:has been|was|is) (?:signed or )?sent(?! until you)|nothing (?:has been|was) signed|no transaction (?:has been|was) sent/i,
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
  // A promise about what comes next, not a report on what happened: it holds before the first
  // signature of a close, and in its "nothing more" form once an earlier run may have sent some.
  "sent-only-when-signed": /nothing is sent until you (?:sign|do)/i,
  "more-sent-only-when-signed": /nothing more is sent until you (?:sign|do)/i,
  // Past the confirm a close always has a saved record (the confirm holds without one), so a
  // close stopped after it can be resumed. Not said before a plan is reviewed.
  "resume-after-stop": /if you stop midway[^.]*you can resume/i,
  "funds-safe": /funds are safe|funds stay safe/i,
  "nothing-lost": /nothing is lost|resume exactly where|step (?:already completed )?is skipped/i,
  "can-resume": /resume(?:d)? (?:it |this close )?later/i,
  // How far a saved close got is only ever what this browser recorded, never the account's state.
  "recorded-progress": /recorded in this browser|this browser recorded/i,
  // The secret key's handling: it stays on the device and only in memory.
  "key-stays-in-browser": /key never leaves (?:your browser|this device)|held in memory only/i,
  // That this browser holds the receipt: true only after its write resolved.
  "receipt-saved": /receipt (?:is |was )?saved (?:to|in)/i,
  // The XLM the destination received, as the ledger's result for the merge reports it. Only a
  // finished close has one; in the source the figure is an expression.
  "amount-received": /\breceived (?:[\d,]+(?:\.\d+)?|\{[^}]*\}) XLM\b/i,
  // Where signatures are given: every signer in this browser, until signing from another device
  // ships.
  "same-browser-signing":
    /must (?:also )?sign here, in this browser|signing from another device is not supported/i,
};

export function permittedClaims(journey: Journey): ClaimKey[] {
  return (Object.keys(CLAIM_PATTERNS) as ClaimKey[]).filter((claim) => allows(journey, claim));
}
