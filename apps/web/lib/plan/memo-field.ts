/**
 * The destination memo as the page validates it, in one pure place: what type it is, what goes
 * on chain, how many bytes it takes, and why it cannot be used.
 *
 * `normalized` is the memo that goes on chain, shown on review and sent in the request, so all
 * three are the same string. Nothing in it is ever removed or rewritten beyond the surrounding
 * whitespace: a value that cannot be sent as typed is refused with a reason instead, because a
 * silently altered memo credits a different deposit, or nobody.
 */

import { isValidGAddress } from "@/lib/utils/validation";
import { lookupExchange } from "@/lib/exchange-registry";
import type { MemoFact } from "@/lib/plan/open-items";

export type ChosenMemoType = "text" | "id";

export const TEXT_MEMO_MAX_BYTES = 28;
const UINT64_MAX = BigInt("18446744073709551615");

export interface MemoField {
  type: "text" | "id" | "hash";
  /** The registry lists the destination, so its memo type is not the user's to choose. */
  typeFixed: boolean;
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

export function memoField(destination: string, memo: string, chosen: ChosenMemoType): MemoField {
  const entry = isValidGAddress(destination) ? lookupExchange(destination) : null;
  const type = entry?.memoType ?? chosen;
  const required = entry?.requiresMemo ?? false;
  const normalized = memo.trim();
  const error =
    normalized === ""
      ? required
        ? "This exchange needs a memo."
        : null
      : valueError(normalized, type);
  return {
    type,
    typeFixed: entry !== null,
    required,
    exchangeName: entry?.name ?? null,
    normalized,
    bytes: memoBytes(normalized),
    error,
    fact: error === null ? "ok" : normalized === "" ? "missing" : "invalid",
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
 * signed transaction is held to. The type follows `memoField`: the registry's for a listed
 * exchange, the user's choice otherwise, and text for a record saved before the choice existed,
 * which is also what the API uses when no type is sent.
 */
export function confirmedMemo(
  destination: string,
  memo: string | null,
  memoType: "text" | "id" | "hash" | null
): ConfirmedMemo | null {
  const normalized = memo?.trim() ?? "";
  if (normalized === "") return null;
  const entry = isValidGAddress(destination) ? lookupExchange(destination) : null;
  return { memo: normalized, memoType: entry?.memoType ?? memoType ?? "text" };
}

/** Whether an edit to an id memo is refused as it is typed: anything but digits. The edit is
 *  refused whole, never filtered, so what the field holds is always what was typed. */
export function refusesIdMemoEdit(next: string): boolean {
  return /[^\d\s]/.test(next);
}
