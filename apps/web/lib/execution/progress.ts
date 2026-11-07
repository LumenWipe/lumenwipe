import type { CloseProgressEvent, CloseTransactionProgress } from "@lumenwipe/sdk";
import type { PlannedStep } from "@/types/plan";

/** What a running close is waiting on. */
export type ProgressWait =
  | "preparing"
  | "checking"
  | "verifying"
  /** A browser wallet's prompt. */
  | "wallet"
  /** A wallet on another device, reached through a relay such as WalletConnect. */
  | "wallet-app"
  | "key"
  | "preimage"
  | "relay"
  | "sponsor"
  | "network"
  | "confirmed";

/** Which transaction of the close is in flight. `total` is a floor when `atLeast` is set. */
export interface ProgressPosition {
  n: number;
  total: number;
  atLeast: boolean;
}

export interface CloseProgress {
  wait: ProgressWait;
  position: ProgressPosition | null;
  /** When `wait` started, in ms since the epoch. */
  since: number;
}

/** After this long on one wait the progress line says the close is still going. */
export const STALL_SECONDS = 20;
export const STILL_WAITING = "Still waiting. Do not close this tab.";

const ACTIONS: Record<Exclude<ProgressWait, "preparing" | "checking">, string> = {
  verifying: "checking it matches your choices",
  wallet: "approve in your wallet",
  "wallet-app": "approve in your wallet app",
  key: "signing with your key",
  preimage: "signing with your preimage",
  relay: "getting the relay account's signature",
  sponsor: "requesting a sponsored fee",
  network: "confirming on Stellar (usually under 10 seconds)",
  confirmed: "confirmed",
};

/** The one line that says which transaction is in flight and what it is waiting on. */
export function progressLine(progress: CloseProgress): string {
  if (progress.wait === "preparing") return "Preparing transactions…";
  if (progress.wait === "checking") return "Checking the network…";
  const action = ACTIONS[progress.wait];
  const at = progress.position;
  if (!at) return `${action.charAt(0).toUpperCase()}${action.slice(1)}`;
  return `Transaction ${at.n} of ${at.atLeast ? "at least " : ""}${at.total}: ${action}`;
}

/** Whether a wait has gone on long enough to say so. A confirmation is never a wait. */
export function isStalled(progress: CloseProgress, now: number): boolean {
  return progress.wait !== "confirmed" && now - progress.since >= STALL_SECONDS * 1000;
}

/** `m:ss`, for a visible elapsed timer. */
export function formatElapsed(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** How many transactions of this close are already confirmed, as the plan records them. */
export function confirmedTransactions(plan: readonly PlannedStep[]): number {
  return new Set(
    plan.filter((s) => s.status === "confirmed" && s.txHash).map((s) => s.txHash as string)
  ).size;
}

// "signer" stands for whichever prompt the signer in use has; "submitting" is left to the close
// loop's own prepare and submit callbacks, which know whether a relay, a sponsor or the network
// is being waited on.
const TRANSACTION_WAITS: Record<CloseTransactionProgress["phase"], ProgressWait | "signer" | null> =
  {
    verifying: "verifying",
    "awaiting-signature": "signer",
    submitting: null,
    confirmed: "confirmed",
  };

/** What a progress event says is waited on, or null when the event does not say. */
export function waitOf(event: CloseProgressEvent, signerWait: ProgressWait): ProgressWait | null {
  if (!("txIndex" in event)) return "preparing";
  const wait = TRANSACTION_WAITS[event.phase];
  return wait === "signer" ? signerWait : wait;
}

/** Whether the event reports a transaction confirming. */
export function isConfirmation(event: CloseProgressEvent): boolean {
  return "txIndex" in event && TRANSACTION_WAITS[event.phase] === "confirmed";
}

/**
 * Numbers a transaction across the whole close, not just this run: `before` is how many
 * transactions were confirmed when this run first reported one, `confirmedInRun` how many this
 * run confirmed since. So a retry or a resumed multisig round keeps counting from where the close
 * is. The total is exact for the current round only; with more rounds expected it is a floor.
 */
export function positionOf(
  event: CloseTransactionProgress,
  before: number,
  confirmedInRun: number
): ProgressPosition {
  const n = before + confirmedInRun + (isConfirmation(event) ? 0 : 1);
  return {
    n,
    total: n + (event.txCount - event.txIndex - 1),
    atLeast: event.moreRoundsExpected,
  };
}

/** The step a close is on: the first one neither confirmed nor skipped, or -1 when none is. */
export function activeStepIndex(plan: readonly PlannedStep[]): number {
  const open = plan.find((s) => s.status !== "confirmed" && s.status !== "skipped");
  return open ? open.index : -1;
}
