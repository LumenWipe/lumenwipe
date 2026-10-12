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

export type CloseDidNotConvergeReason = "round_limit" | "empty_batch";

const ROUND_MARGIN = 5;
const HARD_MAX_ROUNDS = 200;

/** Thrown when a close cannot finish: the API kept asking for another call past the round
 *  bound, or said another call is needed yet returned nothing to sign. Nothing is lost - the
 *  API re-reads live state, so running the close again picks up where it stopped. */
export class CloseDidNotConvergeError extends Error {
  constructor(
    public readonly rounds: number,
    public readonly bound: number,
    public readonly reason: CloseDidNotConvergeReason
  ) {
    super(
      reason === "empty_batch"
        ? "The close stopped because the service reported more steps but had nothing to sign. Check your account, then try again - the close picks up where it stopped."
        : `The close needed more steps than expected (${rounds} of at most ${bound}). Check your account, then try again - the close picks up where it stopped.`
    );
    this.name = "CloseDidNotConvergeError";
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
  /**
   * Overrides the round bound. Without it the bound is derived each round from the API's own
   * `remaining.steps` (rounds done, plus steps left, plus a margin), only ever raised and capped
   * at 200, so a long close is not cut short and a misbehaving API still cannot spin forever.
   * This is what covers
   * #59's mediator-cleanup concern: the API is stateless and re-reads live state every round,
   * so `remaining.requiresAnotherCall` for that flow reflects "cleanup still sees something to
   * remove," not a bounded countdown - if an asset keeps getting re-funded between rounds (or
   * any other close path never converges for whatever reason), this stops it after `maxRounds`
   * with a clear thrown error instead of looping indefinitely.
   */
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
  let bound = 0;

  if (resume) {
    await signOrThrow(deps, resume.tx, resume.xdr, resume.queue, resume.requiresAnotherCall);
    await processTxs(deps, resume.queue, resume.requiresAnotherCall);
    if (!resume.requiresAnotherCall) return;
  }

  for (let round = 0; round < (deps.maxRounds ?? Math.max(bound, 1)); round++) {
    deps.onProgress?.("Preparing transactions…");
    const batch = await deps.getTransactions();
    const txs = [...batch.transactions].sort((a, b) => a.order - b.order);
    const { requiresAnotherCall, steps } = batch.remaining;
    if (requiresAnotherCall && txs.length === 0) {
      throw new CloseDidNotConvergeError(round + 1, deps.maxRounds ?? bound, "empty_batch");
    }
    await processTxs(deps, txs, requiresAnotherCall);
    if (!requiresAnotherCall) return;
    bound = Math.max(bound, Math.min(HARD_MAX_ROUNDS, round + 1 + steps + ROUND_MARGIN));
  }

  throw new CloseDidNotConvergeError(
    deps.maxRounds ?? bound,
    deps.maxRounds ?? bound,
    "round_limit"
  );
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
