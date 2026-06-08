import { TransactionBuilder } from "@stellar/stellar-sdk";
import { getRpcServer } from "./rpc";
import { translateRpcError, TxTimeoutError } from "@/lib/utils/errors";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import type { Network } from "@/config/networks";
import { POLL_INTERVAL_MS, POLL_MAX_ATTEMPTS } from "@/config/constants";

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

  onStatus?.("Submitting to Stellar network...");

  // Parse XDR string to transaction object (required by rpc.Server.sendTransaction)
  const tx = TransactionBuilder.fromXDR(signedXdr, passphrase);

  let sendResult: Awaited<ReturnType<typeof server.sendTransaction>>;
  try {
    sendResult = await server.sendTransaction(tx);
  } catch (e) {
    throw e instanceof Error ? e : new Error(String(e));
  }

  if (sendResult.status === "TRY_AGAIN_LATER") {
    throw new Error("Network is overloaded. Please retry in a moment.");
  }

  if (sendResult.status === "ERROR") {
    const raw = sendResult.errorResult != null ? sendResult.errorResult.toXDR("base64") : "ERROR";
    throw new Error(translateRpcError("ERROR", raw));
  }

  // DUPLICATE means the transaction was already submitted - treat as success and poll
  const txHash = sendResult.hash;
  onStatus?.("Waiting for ledger confirmation...");

  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

    let result;
    try {
      result = await server.getTransaction(txHash);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Network/connectivity errors must propagate — don't treat them as success.
      if (/fetch|network|ECONNREFUSED|ETIMEDOUT|timeout|abort/i.test(msg)) throw err;
      // XDR parse error from protocol version mismatch (e.g. TransactionMetaV4):
      // NOT_FOUND responses carry no XDR, so a parse error here means the tx
      // was found and applied to the ledger. Treat as success.
      return { txHash, ledger: 0 };
    }

    if (result.status === "SUCCESS") {
      return { txHash, ledger: result.ledger ?? 0 };
    }

    if (result.status === "FAILED") {
      throw new Error(translateRpcError("FAILED", String(result.resultXdr ?? "FAILED")));
    }
    // status === "NOT_FOUND" means still pending - keep polling
  }

  throw new TxTimeoutError();
}
