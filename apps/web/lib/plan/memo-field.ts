/**
 * The destination memo as the page validates it, in one pure place: what type it is, what goes
 * on chain, how many bytes it takes, and why it cannot be used.
 *
 * `normalized` is the memo that goes on chain, shown on review and sent in the request, so all
 * three are the same string. Nothing in it is ever removed or rewritten beyond the surrounding
 * whitespace: a value that cannot be sent as typed is refused with a reason instead, because a
 * silently altered memo credits a different deposit, or nobody.
 */

import type { Network } from "@/config/networks";
import { isValidGAddress } from "@/lib/utils/validation";
import { bundledExchange, lookupExchange } from "@/lib/exchange-registry";
import type { MemoFact } from "@/lib/plan/open-items";

export type ChosenMemoType = "text" | "id";

/** Which registry lists the destination: the bundled one, only the served one, or neither. */
export type MemoListing = "bundled" | "served" | "unlisted";

export const TEXT_MEMO_MAX_BYTES = 28;
const UINT64_MAX = BigInt("18446744073709551615");

export interface MemoField {
  type: "text" | "id" | "hash";
  /** The memo type is not the user's to choose: the bundled registry lists the destination, or
   *  the served one lists it with a hash memo, which cannot be sent whatever the choice. */
  typeFixed: boolean;
  listing: MemoListing;
  /** The type the served registry gives an address only it lists, to hold the user's choice to;
   *  null otherwise. Never the type that is sent. */
  servedType: "text" | "id" | "hash" | null;
  /** Whether the type is settled: fixed, chosen for this destination, or unlisted, where the
   *  choice has always defaulted to text. */
  typeChosen: boolean;
  required: boolean;
  exchangeName: string | null;
  normalized: string;
  /** UTF-8 bytes of `normalized`; what the text memo limit counts. */
  bytes: number;
  error: string | null;
  fact: MemoFact;
  /** The type that goes with the memo, or null when there is no memo. */
  memoType: "text" | "id" | "hash" | null;
}

export function memoBytes(memo: string): number {
  return new TextEncoder().encode(memo).length;
}

function valueError(memo: string, type: MemoField["type"]): string | null {
  if (type === "hash") {
    return "This exchange asks for a hash memo, which LumenWipe cannot send. Close to a personal wallet you control and send it from there.";
  }
  if (type === "id") {
    if (!/^\d+$/.test(memo)) return "An id memo is digits only.";
    // The network stores the number, so "007" would go on chain as 7 and no longer match the
    // memo the user confirmed.
    if (memo.length > 1 && memo.startsWith("0")) return "An id memo cannot start with 0.";
    if (BigInt(memo) > UINT64_MAX) return "An id memo is at most 18446744073709551615.";
    return null;
  }
  const bytes = memoBytes(memo);
  return bytes > TEXT_MEMO_MAX_BYTES
    ? `This memo is ${bytes} bytes. A text memo holds at most ${TEXT_MEMO_MAX_BYTES}.`
    : null;
}

/**
 * `chosenForDestination` says the user picked `chosen` for this destination. It matters only for
 * an address the served registry alone lists: that copy is not authenticated, so its memo type is
 * never adopted, and the user states one that the served type is then held to.
 */
export function memoField(
  destination: string,
  network: Network,
  memo: string,
  chosen: ChosenMemoType,
  chosenForDestination: boolean
): MemoField {
  const entry = isValidGAddress(destination) ? lookupExchange(destination, network) : null;
  // A served copy can add an exchange, but its memo type is then the user's to state.
  const listing: MemoListing =
    entry === null
      ? "unlisted"
      : bundledExchange(destination, network) !== null
        ? "bundled"
        : "served";
  const typeFixed = entry !== null && (listing === "bundled" || entry.memoType === "hash");
  const type = typeFixed ? entry.memoType : chosen;
  const servedType = listing === "served" && entry !== null ? entry.memoType : null;
  const typeChosen = listing !== "served" || typeFixed || chosenForDestination;
  const required = entry?.requiresMemo ?? false;
  const normalized = memo.trim();
  const error =
    normalized === ""
      ? required
        ? "This exchange needs a memo."
        : null
      : valueError(normalized, type);
  const typeMatters = !typeFixed && servedType !== null && (normalized !== "" || required);
  const fact: MemoFact =
    typeMatters && !typeChosen
      ? "type-unchosen"
      : typeMatters && type !== servedType
        ? "type-mismatch"
        : error === null
          ? "ok"
          : normalized === ""
            ? "missing"
            : "invalid";
  return {
    type,
    typeFixed,
    listing,
    servedType,
    typeChosen,
    required,
    exchangeName: entry?.name ?? null,
    normalized,
    bytes: memoBytes(normalized),
    error,
    fact,
    memoType: normalized === "" ? null : type,
  };
}

export interface ConfirmedMemo {
  memo: string;
  memoType: "text" | "id" | "hash";
}

/**
 * The memo and type a close sends and verifies, from what the plan page stored. One value feeds
 * both the transactions request and `verify()`, so the type the API is asked for is the type the
 * signed transaction is held to. The type follows `memoField`: the registry's for an exchange
 * the bundled registry lists, the user's choice otherwise (an address only the served registry
 * lists included, so `verify()` holds the served type to it), and text for a record saved before
 * the choice existed, which is also what the API uses when no type is sent.
 */
export function confirmedMemo(
  destination: string,
  network: Network,
  memo: string | null,
  memoType: "text" | "id" | "hash" | null
): ConfirmedMemo | null {
  const normalized = memo?.trim() ?? "";
  if (normalized === "") return null;
  const entry = isValidGAddress(destination) ? lookupExchange(destination, network) : null;
  const bundled =
    entry !== null && bundledExchange(destination, network) !== null ? entry.memoType : null;
  return { memo: normalized, memoType: bundled ?? memoType ?? "text" };
}

/** Whether an edit to an id memo is refused as it is typed: anything but digits. The edit is
 *  refused whole, never filtered, so what the field holds is always what was typed. */
export function refusesIdMemoEdit(next: string): boolean {
  return /[^\d\s]/.test(next);
}
