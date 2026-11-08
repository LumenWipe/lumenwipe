/**
 * What is still open on the analyze screen, and why the button to the review is not available.
 *
 * One pure source for the button, the reasons listed under it, the group chips and the jump
 * links, so none of them can disagree with another: the disagreement between two local copies of
 * "is everything resolved" is what once let a real account reach the review with decisions it was
 * never shown (resolvable-blockers.ts). None of this is the gate before a build: `proceedError`
 * on the plan fetched at proceed time stays authoritative.
 */

import type { ClaimableBalanceDecision } from "@/lib/api/plan-adapters";
import type { ClaimableBalanceSelection } from "@/types/plan";
import { claimResolved } from "@/lib/plan/asset-resolution";
import { stroopsToXlm, xlmToStroops } from "@/lib/utils/amounts";

export type PlanGroupType =
  | "NORMALIZE_SIGNERS"
  | "REVOKE_SPONSORSHIP"
  | "REMOVE_DATA_ENTRIES"
  | "CANCEL_OFFERS"
  | "CLAIM_BALANCES"
  | "DEFI_POSITIONS"
  | "HANDLE_ASSETS"
  | "REMOVE_TRUSTLINES"
  | "MERGE";

/** One decision the user still owes, in the order the page shows them. */
export interface OpenItem {
  id: string;
  kind: "claim" | "asset" | "confirmation";
  /** The accordion group that holds it, or null when it sits outside the accordion. */
  group: PlanGroupType | null;
  /** The code of an asset left open because a swap of it has no quote to hold it to. It gets a
   *  reason of its own that names it, instead of a place in the "Open" count. */
  unquoted?: string;
}

/** The element a reason or a jump moves focus to, and the group to open first. */
export interface JumpTarget {
  selector: string;
  group: PlanGroupType | null;
}

export interface ProceedReason {
  key: string;
  text: string;
  /** Null when there is nothing on screen to move to yet. */
  target: JumpTarget | null;
}

export type DestinationFact = "empty" | "invalid" | "self" | "ok";
/** `type-unchosen` and `type-mismatch` are for an exchange only the served registry lists: its
 *  memo type is the user's to state, and a served type that differs stops the close. */
export type MemoFact = "ok" | "missing" | "invalid" | "type-unchosen" | "type-mismatch";

/** Everything the button depends on, as plain facts the view derives. */
export interface ProceedFacts {
  /** A plan is being fetched; the one on screen is about to be replaced. */
  replanning: boolean;
  /** The last re-plan failed: the plan on screen may not answer the latest choices. */
  planStale: boolean;
  /** Hard blockers other than the two the page's own confirmations clear. */
  otherHardBlockers: number;
  /** The account holds balances the plan's asset list did not come back for. */
  assetCardsWithheld: boolean;
  openItems: readonly OpenItem[];
  destination: DestinationFact;
  /** An exchange destination with deposit rules past their expiry. */
  registryStale: boolean;
  /** An exchange destination whose memo type the served and bundled registries disagree on. */
  registryMemoTypeDisputed: boolean;
  memo: MemoFact;
  destinationUnacknowledged: boolean;
}

/** The selector of the element that holds an open item; the page puts it on that element. */
export function openItemSelector(id: string): string {
  return `[data-open-item="${id.replace(/["\\]/g, "\\$&")}"]`;
}

export const BLOCKERS_ID = "plan-blockers";
export const REFRESH_ID = "plan-refresh";
export const DESTINATION_ID = "plan-destination";

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "2 assets, 1 claimable balance": what kinds of decision are still open. */
export function openSummary(items: readonly OpenItem[]): string {
  const count = (kind: OpenItem["kind"]) => items.filter((i) => i.kind === kind).length;
  const parts: string[] = [];
  const assets = count("asset");
  const claims = count("claim");
  const confirmations = count("confirmation");
  if (assets > 0) parts.push(plural(assets, "asset", "assets"));
  if (claims > 0) parts.push(plural(claims, "claimable balance", "claimable balances"));
  if (confirmations > 0) parts.push(plural(confirmations, "confirmation", "confirmations"));
  return parts.join(", ");
}

export function jumpToItem(item: OpenItem): JumpTarget {
  return { selector: openItemSelector(item.id), group: item.group };
}

/**
 * Why the button is disabled, one line each, in the order the page reads. Empty exactly when
 * the button may be used.
 */
export function proceedReasons(facts: ProceedFacts): ProceedReason[] {
  const reasons: ProceedReason[] = [];
  if (facts.replanning) {
    reasons.push({ key: "replanning", text: "The plan is being updated", target: null });
  }
  if (facts.planStale) {
    reasons.push({
      key: "stale",
      text: "The plan below may not reflect your last answer",
      target: null,
    });
  }
  if (facts.otherHardBlockers > 0) {
    reasons.push({
      key: "blockers",
      text:
        facts.otherHardBlockers === 1
          ? "Resolve the blocker above"
          : `Resolve the ${facts.otherHardBlockers} blockers above`,
      target: { selector: `#${BLOCKERS_ID}`, group: null },
    });
  }
  if (facts.assetCardsWithheld) {
    reasons.push({
      key: "withheld",
      text: "The plan for this account's assets could not be loaded. Refresh to try again",
      target: { selector: `#${REFRESH_ID}`, group: null },
    });
  }
  const counted = facts.openItems.filter((i) => i.unquoted === undefined);
  const [first] = counted;
  if (first) {
    reasons.push({
      key: "open",
      text: `Open: ${openSummary(counted)}`,
      target: jumpToItem(first),
    });
  }
  // Each one named: the review refuses a swap with no minimum, so saying only "1 asset" would
  // leave the user guessing why an answer that looks chosen still holds the button.
  for (const item of facts.openItems) {
    if (item.unquoted === undefined) continue;
    reasons.push({
      key: `unquoted:${item.id}`,
      text: `No swap quote is available for ${item.unquoted}, so it cannot be swapped in this close. Choose another answer for it, or refresh the plan`,
      target: jumpToItem(item),
    });
  }
  // The destination field is on screen from the first paint, so its reasons always link to it.
  const field = (selector: string): JumpTarget => ({ selector, group: null });
  const address = field(`#${DESTINATION_ID} input`);
  if (facts.destination === "empty") {
    reasons.push({ key: "destination", text: "Enter a destination", target: address });
  } else if (facts.destination === "invalid") {
    reasons.push({
      key: "destination",
      text: "Enter a valid Stellar address as the destination",
      target: address,
    });
  } else if (facts.destination === "self") {
    reasons.push({
      key: "destination",
      text: "The destination cannot be the account being closed",
      target: address,
    });
  }
  if (facts.registryStale) {
    reasons.push({
      key: "registry",
      text: "This exchange's deposit rules have expired, so it cannot be used as the destination",
      target: address,
    });
  } else if (facts.registryMemoTypeDisputed) {
    reasons.push({
      key: "registry",
      text: "This exchange's memo rules could not be confirmed right now. Try again later or choose another destination",
      target: address,
    });
  }
  if (facts.memo === "type-unchosen") {
    reasons.push({
      key: "memo",
      text: "Choose the memo type this exchange asks for",
      target: field('[data-jump="destination-memo-type"]'),
    });
  } else if (facts.memo === "type-mismatch") {
    reasons.push({
      key: "memo",
      text: "The memo type you chose does not match this exchange's deposit rules",
      target: field('[data-jump="destination-memo-type"]'),
    });
  } else if (facts.memo === "missing") {
    reasons.push({
      key: "memo",
      text: "Memo is required by this exchange",
      target: field('[data-jump="destination-memo"]'),
    });
  } else if (facts.memo === "invalid") {
    reasons.push({
      key: "memo",
      text: "The memo is not valid",
      target: field('[data-jump="destination-memo"]'),
    });
  }
  if (facts.destinationUnacknowledged) {
    reasons.push({
      key: "acknowledge",
      text: "Confirm the destination is a wallet you control",
      target: field('[data-jump="destination-acknowledge"]'),
    });
  }
  return reasons;
}

/** What the live region says: a count of what the user still has to do, never the list itself.
 *  A plan being updated is not counted: the page announces that on its own, and counting it
 *  would change the summary, and talk over "Plan updated", on every re-plan. */
export function reasonsSummary(reasons: readonly ProceedReason[]): string {
  const left = reasons.filter((r) => r.key !== "replanning").length;
  return left === 0
    ? "Ready to review the full plan"
    : `${plural(left, "thing", "things")} left before you can review the plan`;
}

export type GroupChip =
  { kind: "needs"; count: number } | { kind: "done" } | { kind: "informational" };

/** A group's chip. `open` is the number of decisions open in it, or null for a group that asks
 *  for none. */
export function groupChip(open: number | null): GroupChip {
  if (open === null) return { kind: "informational" };
  return open > 0 ? { kind: "needs", count: open } : { kind: "done" };
}

export function chipLabel(chip: GroupChip): string {
  if (chip.kind === "needs") return `Needs your answer (${chip.count})`;
  return chip.kind === "done" ? "Done" : "Informational";
}

/**
 * The group to open for the open items, given the ids already seen. On the first call (`seen`
 * null) it is the group of the first open item; afterwards only an item that was not there
 * before opens its group, so a user's own open and close stand until something new needs them.
 */
export function newlyOpenGroup(
  seen: ReadonlySet<string> | null,
  items: readonly OpenItem[]
): PlanGroupType | null {
  const candidates = seen === null ? items : items.filter((i) => !seen.has(i.id));
  return candidates.find((i) => i.group !== null)?.group ?? null;
}

/** The claimable balances of one asset, as the claim section shows them. */
export interface ClaimGroup {
  asset: string;
  code: string;
  /** The issuer of a classic asset; null for XLM. Two groups can share a code, never an issuer. */
  issuer: string | null;
  balances: ClaimableBalanceDecision[];
  /** The sum of the balances, or null when one of the amounts cannot be read. */
  total: string | null;
  answered: number;
  /** The balances a bulk answer may set: the ones the account can claim now, for which the plan
   *  offers both claiming and leaving. Never one that needs a trustline or cannot be claimed in
   *  this close: those take their own answer. */
  bulkIds: string[];
}

function stroopsOf(amount: string): bigint | null {
  try {
    return /^\d+(\.\d+)?$/.test(amount) ? BigInt(xlmToStroops(amount)) : null;
  } catch {
    return null;
  }
}

/** Claimable balances grouped by asset in the order the plan lists them, summed in stroops. */
export function claimGroups(
  decisions: readonly ClaimableBalanceDecision[],
  selections: Readonly<Record<string, ClaimableBalanceSelection>>
): ClaimGroup[] {
  const byAsset = new Map<string, ClaimableBalanceDecision[]>();
  for (const b of decisions) byAsset.set(b.asset, [...(byAsset.get(b.asset) ?? []), b]);
  return [...byAsset.entries()].map(([asset, balances]) => {
    let sum: bigint | null = BigInt(0);
    for (const b of balances) {
      const stroops = stroopsOf(b.amount);
      sum = sum === null || stroops === null ? null : sum + stroops;
    }
    return {
      asset,
      code: balances[0].code,
      issuer: asset === "native" ? null : (asset.split(":")[1] ?? null),
      balances,
      total: sum === null ? null : stroopsToXlm(sum),
      answered: balances.filter((b) => claimResolved(b, selections[b.balanceId])).length,
      bulkIds: balances
        .filter((b) => b.offered.includes("claim") && b.offered.includes("forfeit"))
        .map((b) => b.balanceId),
    };
  });
}
