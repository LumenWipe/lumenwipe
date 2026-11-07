import { CLOSING_STEPS } from "@/lib/receipt/build-record";
import { stroopsToFixedLumens } from "@/lib/utils/amounts";
import type { ReceiptRecord } from "@/types/history";

const TX_HASH = /^[0-9a-f]{64}$/i;
const STROOPS = /^\d+$/;
/** The proxy route's cap (`DELIVERED_MAX_HASHES`): more could not be asked about. */
const MAX_HASHES = 5;

/**
 * The transactions whose delivery is the amount received: the ones that carried the merge. Any
 * other transaction of a close delivers nothing to the destination this way, and asking about it
 * would leave the total unanswered. Lowercase and distinct. Null when there is nothing that can
 * be asked about: no merge confirmed, or a merge hash the record holds in no valid form.
 */
export function closingHashes(record: ReceiptRecord): string[] | null {
  if (record.outcome !== "closed") return null;
  const closing = record.transactions.filter((tx) =>
    tx.stepTypes.some((type) => CLOSING_STEPS.includes(type))
  );
  if (closing.length === 0 || closing.some((tx) => !TX_HASH.test(tx.txHash))) return null;
  const hashes = [...new Set(closing.map((tx) => tx.txHash.toLowerCase()))];
  return hashes.length <= MAX_HASHES ? hashes : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The XLM the asked transactions delivered, as a seven-decimal string, or null when the answer
 * does not establish it. Only an answer for this destination, with one delivered entry per asked
 * hash in order and a total equal to their sum, is read as an amount. Anything else, an
 * unavailable entry included, is null: an amount is never inferred from part of an answer.
 */
export function readReceived(
  response: unknown,
  asked: { destination: string; hashes: readonly string[] }
): string | null {
  if (!isObject(response)) return null;
  const { destination, entries, totalStroops } = response;
  if (
    typeof destination !== "string" ||
    destination.toUpperCase() !== asked.destination.toUpperCase()
  ) {
    return null;
  }
  if (!Array.isArray(entries) || entries.length !== asked.hashes.length) return null;
  let sum = BigInt(0);
  for (const [i, entry] of entries.entries()) {
    if (
      !isObject(entry) ||
      typeof entry.hash !== "string" ||
      entry.hash.toLowerCase() !== asked.hashes[i].toLowerCase() ||
      entry.status !== "delivered" ||
      typeof entry.amountStroops !== "string" ||
      !STROOPS.test(entry.amountStroops)
    ) {
      return null;
    }
    sum += BigInt(entry.amountStroops);
  }
  if (typeof totalStroops !== "string" || !STROOPS.test(totalStroops)) return null;
  if (BigInt(totalStroops) !== sum) return null;
  return stroopsToFixedLumens(totalStroops);
}
