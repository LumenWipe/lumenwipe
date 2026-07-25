import type { CloseTransaction, TransactionsResponse } from "@lumenwipe/sdk";

export interface CloseEngineDeps {
  /** Fetches the next round of unsigned transactions from the API (via the proxy). */
  getTransactions: () => Promise<TransactionsResponse>;
  /**
   * Verifies one server-built transaction against what the client independently expects.
   * MUST throw on any mismatch. This is the trust anchor: the browser never signs a
   * server-built transaction it cannot fully account for. Injected so it can be tested in
   * isolation; the hook supplies the real `verifyCloseTransaction`.
   */
  verify: (tx: CloseTransaction) => void;
  /** Signs (and, for a mediator transaction, co-signs) then submits; resolves to the tx hash. */
  signAndSubmit: (tx: CloseTransaction) => Promise<string>;
  /** Called after a transaction confirms, with the transaction and its hash. */
  onConfirmed?: (tx: CloseTransaction, hash: string) => void;
  onProgress?: (message: string) => void;
  /** Safety bound so a misbehaving API can never spin the loop forever. */
  maxRounds?: number;
}

/**
 * Runs the full multi-round close. Each round: fetch a batch of unsigned transactions,
 * **verify every one before signing**, then sign + submit them in `order`, and repeat while
 * the API reports more rounds remain. Verification runs before signing for each transaction;
 * a failed verification aborts the whole close before any signature is produced.
 */
export async function runClose(deps: CloseEngineDeps): Promise<void> {
  const maxRounds = deps.maxRounds ?? 25;

  for (let round = 0; round < maxRounds; round++) {
    deps.onProgress?.("Preparing transactions…");
    const batch = await deps.getTransactions();
    const txs = [...batch.transactions].sort((a, b) => a.order - b.order);

    for (const tx of txs) {
      // Trust anchor: verify BEFORE signing. Throwing here means nothing is signed.
      deps.verify(tx);
      const hash = await deps.signAndSubmit(tx);
      deps.onConfirmed?.(tx, hash);
    }

    if (!batch.remaining.requiresAnotherCall) return;
  }

  throw new Error("The close did not converge after the maximum number of rounds.");
}
