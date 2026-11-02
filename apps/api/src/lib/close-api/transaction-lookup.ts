import type { rpc } from "@stellar/stellar-sdk";
import type { TransactionLookupResponse } from "@lumenwipe/types";
import { extractResultCode, translateRpcError } from "@/lib/utils/errors";
import { serializeResultXdr } from "@/lib/stellar/submit";

/** What one RPC read knows about a transaction. `not_found` carries the window that was searched,
 *  because outside it the answer means nothing. */
export async function lookupTransaction(
  server: Pick<rpc.Server, "getTransaction">,
  hash: string
): Promise<TransactionLookupResponse> {
  const seen = await server.getTransaction(hash);
  if (seen.status === "SUCCESS") return { status: "confirmed", hash, ledger: seen.ledger };
  if (seen.status === "FAILED") {
    const raw = serializeResultXdr(seen.resultXdr);
    return {
      status: "failed",
      hash,
      ledger: seen.ledger,
      message: translateRpcError("FAILED", raw),
      ...(extractResultCode(raw) !== null && { resultCode: extractResultCode(raw)! }),
    };
  }
  return {
    status: "not_found",
    hash,
    searched: {
      oldestLedger: seen.oldestLedger,
      oldestLedgerCloseTime: Number(seen.oldestLedgerCloseTime),
      latestLedger: seen.latestLedger,
      latestLedgerCloseTime: Number(seen.latestLedgerCloseTime),
    },
  };
}
