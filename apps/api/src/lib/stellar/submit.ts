import { TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { getRpcServer } from "./rpc";
import {
  translateRpcError,
  TxTimeoutError,
  TxSubmitError,
  extractResultCode,
} from "@/lib/utils/errors";
import { checkTransactionSignatures, InvalidSignatureError } from "@/lib/stellar/signature";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import type { Network } from "@/config/networks";
import { POLL_INTERVAL_MS, POLL_MAX_ATTEMPTS } from "@/config/constants";

// How many times to retry a TRY_AGAIN_LATER response before surfacing the error.
// The status is transient (node is under load) and typically resolves in seconds.
const TRY_AGAIN_MAX_RETRIES = 3;
const TRY_AGAIN_DELAY_MS = 4_000;

export interface SubmitResult {
  txHash: string;
  ledger: number;
}

export async function submitAndWait(
  signedXdr: string,
  network: Network,
  onStatus?: (status: string) => void
): Promise<SubmitResult> {
  const server = getRpcServer(network);
  const passphrase = NETWORK_PASSPHRASES[network];

  // Offline pre-flight: catch missing/invalid signatures before wasting a round-trip
  checkTransactionSignatures(signedXdr, network);

  onStatus?.("Submitting to Stellar network...");

  const tx = TransactionBuilder.fromXDR(signedXdr, passphrase);
  const txHash = tx.hash().toString("hex");

  // A prior call may have submitted this exact transaction and it confirmed, but the
  // caller never saw the response (network drop, client timeout). By the time a retry
  // arrives, the network's own sendTransaction dedup window (DUPLICATE) may have closed,
  // so resubmitting would surface a stale-sequence rejection instead of the success that
  // already happened. Check history first - if it already confirmed, report that instead
  // of resubmitting (docs/architecture.md §22).
  const priorResult = await server.getTransaction(txHash);
  if (priorResult.status === "SUCCESS") {
    onStatus?.("Already confirmed.");
    return { txHash, ledger: priorResult.ledger };
  }

  // TRY_AGAIN_LATER is a transient congestion signal - retry with backoff before
  // surfacing it as an error, so users are not interrupted for a recoverable state
  let sendResult: Awaited<ReturnType<typeof server.sendTransaction>>;
  let tryAgainCount = 0;
  // eslint-disable-next-line no-constant-condition -- intentional retry loop; exits via break on non-retryable status or throw at the retry cap
  while (true) {
    try {
      sendResult = await server.sendTransaction(tx);
    } catch (e) {
      throw e instanceof Error ? e : new Error(String(e));
    }

    if (sendResult.status !== "TRY_AGAIN_LATER") break;

    if (++tryAgainCount >= TRY_AGAIN_MAX_RETRIES) {
      throw new Error(
        "The network is congested and could not accept the transaction. Please retry in a moment."
      );
    }

    onStatus?.(`Network busy, retrying (${tryAgainCount}/${TRY_AGAIN_MAX_RETRIES})…`);
    await new Promise((r) => setTimeout(r, TRY_AGAIN_DELAY_MS));
  }

  if (sendResult.status === "ERROR") {
    const raw = sendResult.errorResult != null ? sendResult.errorResult.toXDR("base64") : "";
    throw new TxSubmitError(translateRpcError("ERROR", raw), extractResultCode(raw));
  }

  // DUPLICATE means the transaction was already submitted - treat as success and poll.
  // Use server.pollTransaction() (SDK v15.1.0 - off-by-one fixed) instead of a manual
  // getTransaction loop. Preserves the same POLL_MAX_ATTEMPTS × POLL_INTERVAL_MS budget.
  onStatus?.("Waiting for ledger confirmation...");

  const result = await server.pollTransaction(txHash, {
    attempts: POLL_MAX_ATTEMPTS,
    sleepStrategy: () => POLL_INTERVAL_MS,
  });

  if (result.status === "FAILED") {
    const raw = serializeResultXdr(result.resultXdr);
    throw new TxSubmitError(translateRpcError("FAILED", raw), extractResultCode(raw));
  }

  if (result.status === "NOT_FOUND") {
    // Exhausted all polling attempts without a definitive response
    throw new TxTimeoutError();
  }

  // SUCCESS
  return { txHash, ledger: result.ledger ?? 0 };
}

function serializeResultXdr(resultXdr: unknown): string {
  if (!resultXdr) return "";
  if (typeof resultXdr === "string") return resultXdr;
  try {
    return (resultXdr as xdr.TransactionResult).toXDR("base64");
  } catch {
    return "";
  }
}

// Re-export so callers can distinguish signature errors from network errors
export { InvalidSignatureError };
