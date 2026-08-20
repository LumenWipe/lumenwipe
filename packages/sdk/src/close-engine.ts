import type { CloseTransaction, TransactionsResponse } from "@lumenwipe/types";

/** Everything needed to resume signing a transaction that stopped short of its required
 *  signing weight, without re-fetching (which would discard any signature already
 *  collected) or re-verifying (the tx body is unchanged - verified once, before the first
 *  signature; a later signer only adds a signature, never alters the body). */
export interface PendingRound {
  tx: CloseTransaction;
  xdr: string;
  requiredWeight: number;
  accumulatedWeight: number;
  queue: CloseTransaction[];
  requiresAnotherCall: boolean;
}

/** Thrown when a transaction's accumulated signing weight is still short of what it actually
 *  needs after the currently available signer has contributed. Carries everything needed to
 *  resume with a different signer onto the same partially-signed envelope. */
export class InsufficientSignatureWeightError extends Error {
  constructor(public readonly pending: PendingRound) {
    super(
      `Transaction ${pending.tx.id} needs signing weight ${pending.requiredWeight} but only has ${pending.accumulatedWeight}.`
    );
    this.name = "InsufficientSignatureWeightError";
  }
}

export interface CloseEngineDeps {
  /** Fetches the next round of unsigned transactions from the API (via the proxy). */
  getTransactions: () => Promise<TransactionsResponse>;
  /**
   * Verifies one server-built transaction against what the client independently expects.
   * MUST throw on any mismatch. This is the trust anchor: the browser never signs a
   * server-built transaction it cannot fully account for. Injected so it can be tested in
   * isolation; the hook supplies the real `verifyCloseTransaction`.
   * May be sync or async - the engine always awaits it, so a future async verifier
   * (e.g. one that resolves a key or does a lookup) can never be silently bypassed.
   */
  verify: (tx: CloseTransaction) => void | Promise<void>;
  /** The signing weight this transaction actually needs, from its operation set and the
   *  account's real per-category thresholds - never a single account-wide number. */
  requiredWeight: (tx: CloseTransaction) => number;
  /** Signs the given xdr (which may already carry earlier signatures) with the currently
   *  available signer, returning the updated xdr and its total accumulated signing weight
   *  against the account's known signer set. */
  sign: (tx: CloseTransaction, xdr: string) => Promise<{ xdr: string; weight: number }>;
  /** Submits a transaction whose accumulated weight already meets its requirement; resolves
   *  to the tx hash. */
  submit: (tx: CloseTransaction, xdr: string) => Promise<string>;
  /** Called after a transaction confirms, with the transaction and its hash. */
  onConfirmed?: (tx: CloseTransaction, hash: string) => void;
  onProgress?: (message: string) => void;
  /** Safety bound so a misbehaving API can never spin the loop forever. */
  maxRounds?: number;
}

/**
 * Runs the full multi-round close. Each round: fetch a batch of unsigned transactions,
 * verify every one before signing, sign it, and submit only once its accumulated signing
 * weight meets what its operations actually require - otherwise throw
 * InsufficientSignatureWeightError with everything needed to resume onto the same
 * envelope once a different signer is available. Pass that error's `.pending` back in as
 * `resume` to continue exactly where it stopped.
 */
export async function runClose(deps: CloseEngineDeps, resume?: PendingRound): Promise<void> {
  const maxRounds = deps.maxRounds ?? 25;

  if (resume) {
    await signOrThrow(deps, resume.tx, resume.xdr, resume.queue, resume.requiresAnotherCall);
    await processTxs(deps, resume.queue, resume.requiresAnotherCall);
    if (!resume.requiresAnotherCall) return;
  }

  for (let round = 0; round < maxRounds; round++) {
    deps.onProgress?.("Preparing transactions…");
    const batch = await deps.getTransactions();
    const txs = [...batch.transactions].sort((a, b) => a.order - b.order);
    await processTxs(deps, txs, batch.remaining.requiresAnotherCall);
    if (!batch.remaining.requiresAnotherCall) return;
  }

  throw new Error("The close did not converge after the maximum number of rounds.");
}

async function processTxs(
  deps: CloseEngineDeps,
  txs: CloseTransaction[],
  requiresAnotherCall: boolean
): Promise<void> {
  for (let i = 0; i < txs.length; i++) {
    const tx = txs[i];
    await deps.verify(tx);
    await signOrThrow(deps, tx, tx.xdr, txs.slice(i + 1), requiresAnotherCall);
  }
}

async function signOrThrow(
  deps: CloseEngineDeps,
  tx: CloseTransaction,
  xdr: string,
  queue: CloseTransaction[],
  requiresAnotherCall: boolean
): Promise<void> {
  const required = deps.requiredWeight(tx);
  const { xdr: signedXdr, weight } = await deps.sign(tx, xdr);
  if (weight < required) {
    throw new InsufficientSignatureWeightError({
      tx,
      xdr: signedXdr,
      requiredWeight: required,
      accumulatedWeight: weight,
      queue,
      requiresAnotherCall,
    });
  }
  const hash = await deps.submit(tx, signedXdr);
  deps.onConfirmed?.(tx, hash);
}
