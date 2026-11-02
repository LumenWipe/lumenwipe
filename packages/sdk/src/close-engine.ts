import type {
  CloseTransaction,
  TransactionLookupResponse,
  TransactionsResponse,
} from "@lumenwipe/types";

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

/** How many times a round the API refused as `state_changed` is fetched again before the close
 *  stops and asks for a new plan. */
export const STATE_CHANGED_REFETCHES = 2;

/** How long `runClose` waits before each of those re-fetches: about one ledger close, the time a
 *  lagging read provider needs to catch up with a transaction that just confirmed. */
export const STATE_CHANGED_REFETCH_DELAY_MS = 3000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Thrown when the account kept changing while the API prepared a round (`state_changed`).
 *  Nothing was submitted for that round; plan again and run the close from the new plan. */
export class CloseStateChangedError extends Error {
  constructor(public readonly apiError: unknown) {
    super(
      "Your account changed while the close was being prepared, so nothing was submitted. Plan the close again and review it before continuing."
    );
    this.name = "CloseStateChangedError";
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

/** How many more times a transaction whose outcome is unknown is sent, as the same bytes. */
export const SUBMIT_RESEND_ATTEMPTS = 2;

/** How long `runClose` waits before each of those: about one ledger close. */
export const SUBMIT_RESEND_DELAY_MS = 5000;

/** How long past a transaction's time bounds it is still treated as able to land. Absorbs a
 *  client clock running ahead, and the ledger close that decides whether it was in time. */
export const SUBMISSION_GIVE_UP_MARGIN_SECONDS = 120;

/**
 * A transaction handed to the network whose outcome is not settled. Never holds the envelope: a
 * refresh looks this hash up, and does not send anything again. `covers` names a merge only when
 * the client parsed one out of the envelope it signed.
 */
export interface UnresolvedSubmission {
  /** Computed by the client from the final envelope, never taken from the API. */
  hash: string;
  covers: CloseTransaction["covers"];
  /** Unix seconds after which the transaction cannot land; null when it has no time bounds. */
  validUntil: number | null;
  coversTargets?: string[];
  needsSponsoredFee?: boolean;
}

export type SubmissionOutcome =
  | { outcome: "confirmed" }
  | { outcome: "failed"; message: string }
  | { outcome: "expired" }
  | { outcome: "unknown" };

/** Thrown when a transaction went out and neither a resend nor a lookup settled it. Not a failure:
 *  it may still land. Pass `submission` back as `unresolved`, or to `resolveSubmission`. */
export class CloseOutcomeUnknownError extends Error {
  constructor(public readonly submission: UnresolvedSubmission) {
    super(
      "This transaction is not confirmed yet. Your account may already be closed, so check again before doing anything else."
    );
    this.name = "CloseOutcomeUnknownError";
  }
}

/** Thrown when a lookup by the client's own hash shows the transaction failed on the ledger. */
export class CloseTransactionFailedError extends Error {
  constructor(
    public readonly submission: UnresolvedSubmission,
    message: string
  ) {
    super(message);
    this.name = "CloseTransactionFailedError";
  }
}

/** True for an answer that says the request was refused, so nothing went on. Everything else, a
 *  5xx, a timeout, a dropped connection or an unreadable body, leaves the outcome unknown. */
export function isSubmitRefused(error: unknown): boolean {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  return typeof status === "number" && status >= 400 && status < 500;
}

/** Settles a submission by its own hash. A lookup that fails, or that answers for another hash,
 *  settles nothing. The ledger close time in a `not_found` only ever delays giving up: past the
 *  deadline by both clocks is the only way out, so neither clock can end the wait early alone. */
export async function resolveSubmission(
  submission: UnresolvedSubmission,
  lookup: (hash: string) => Promise<TransactionLookupResponse>,
  now: () => number = Date.now
): Promise<SubmissionOutcome> {
  let found: TransactionLookupResponse;
  try {
    found = await lookup(submission.hash);
  } catch {
    return { outcome: "unknown" };
  }
  if (found.hash !== submission.hash) return { outcome: "unknown" };
  if (found.status === "confirmed") return { outcome: "confirmed" };
  if (found.status === "failed") return { outcome: "failed", message: found.message };
  if (submission.validUntil === null) return { outcome: "unknown" };
  const elapsed = Math.min(now() / 1000, found.searched.latestLedgerCloseTime);
  return elapsed > submission.validUntil + SUBMISSION_GIVE_UP_MARGIN_SECONDS
    ? { outcome: "expired" }
    : { outcome: "unknown" };
}

/** Whether a submission is the close's merge. Only ever true for a merge the client parsed. */
export const submissionClosesAccount = (submission: UnresolvedSubmission): boolean =>
  submission.covers.some((step) => step === "MERGE" || step === "CLOSE_ACCOUNT");

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

/** How a run ended. `mergeConfirmed` is true only with `reconcile`, for a transaction the client
 *  parsed as a merge and saw confirmed under its own hash. Without `reconcile` it is always false:
 *  `runClose` returning then says only that the API asked for no more calls, and `covers` is API
 *  metadata, so a caller must establish the merge itself before calling the account closed. */
export interface CloseRunResult {
  mergeConfirmed: boolean;
}

/** What `runClose` needs to settle an unknown outcome. Opt-in: without it a failed `submit` is
 *  surfaced as it is, nothing is sent twice, and nothing here runs. */
export interface CloseReconciliation {
  /** The hash of the exact final envelope, computed locally with the client's own passphrase, so
   *  the outer hash for a fee-bump. MUST NOT come from the API. */
  hashOf: (signedXdr: string) => string;
  /** Whether the client itself parsed an account merge of this account out of the envelope. */
  closesAccount: (signedXdr: string) => boolean;
  /** Unix seconds after which the envelope cannot land, from its own time bounds. */
  validUntil: (signedXdr: string) => number | null;
  /** Looks a hash up on the network, through `client.getTransaction` or a proxy of it. */
  lookup: (hash: string) => Promise<TransactionLookupResponse>;
  /** Told when a submission opens, before it is sent, and with null when it settles: persist it
   *  and an interrupted close still knows what to look up. Rejecting the first call stops the
   *  transaction unsent, which is what a caller that could not persist it should do. */
  onSubmission?: (submission: UnresolvedSubmission | null) => void | Promise<void>;
  /** A submission left over from an earlier run, settled first, by lookup only. */
  unresolved?: UnresolvedSubmission;
  /** A left-over submission confirmed: `onConfirmed` has no transaction to report for it. */
  onResolved?: (submission: UnresolvedSubmission) => void;
  /** Replaces `Date.now`, for tests. */
  now?: () => number;
}

export interface CloseEngineDeps {
  /** Fetches the next round of unsigned transactions from the API (via the proxy). Pass
   *  `planHash` on to `closeTransactions` when it is set. */
  getTransactions: (request: { planHash?: string }) => Promise<TransactionsResponse>;
  /**
   * The `planHash` of the plan the user reviewed. Sent with every fetch until the first
   * transaction of this run confirms, and never after: from then on the account has changed on
   * purpose. A round refused as `state_changed` while it was sent is not fetched again, since the
   * reviewed plan itself is stale; `runClose` throws `CloseStateChangedError` at once.
   */
  planHash?: string;
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
  /** Turns a signed envelope into the final one, adding any co-signature or sponsorship. Runs
   *  once per transaction: a resend never comes back here. */
  prepare?: (tx: CloseTransaction, xdr: string) => Promise<string>;
  /** Submits a transaction whose accumulated weight already meets its requirement; resolves
   *  to the tx hash. */
  submit: (tx: CloseTransaction, xdr: string) => Promise<string>;
  /** Settle unknown outcomes by hash instead of surfacing them. See `CloseReconciliation`. */
  reconcile?: CloseReconciliation;
  /** Called after a transaction confirms, with the transaction and its hash. With `reconcile`,
   *  `covers` names a merge only when the client parsed one, whatever the API claimed. */
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
  /** Waits `ms` milliseconds; defaults to a timer. Injected so tests need not wait. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Runs the full multi-round close. Each round: fetch a batch of unsigned transactions,
 * verify every one before signing, sign it, and submit only once its accumulated signing
 * weight meets what its operations actually require - otherwise throw
 * InsufficientSignatureWeightError with everything needed to resume onto the same
 * envelope once a different signer is available. Pass that error's `.pending` back in as
 * `resume` to continue exactly where it stopped.
 */
export async function runClose(
  deps: CloseEngineDeps,
  resume?: PendingRound
): Promise<CloseRunResult> {
  let bound = 0;
  let planHash = resume ? undefined : deps.planHash;
  const run: EngineRun = {
    ...deps,
    onConfirmed: (tx, hash) => {
      planHash = undefined;
      deps.onConfirmed?.(tx, hash);
    },
  };

  if (deps.reconcile?.unresolved) {
    const settled = await settleLeftOver(deps.reconcile, deps.reconcile.unresolved);
    if (settled === "closed") return { mergeConfirmed: true };
    if (settled === "confirmed") planHash = undefined;
  }

  if (resume) {
    await signOrThrow(run, resume.tx, resume.xdr, resume.queue, resume.requiresAnotherCall);
    await processTxs(run, resume.queue, resume.requiresAnotherCall);
    if (!resume.requiresAnotherCall) return resultOf(run);
  }

  for (let round = 0; round < (run.maxRounds ?? Math.max(bound, 1)); round++) {
    run.onProgress?.("Preparing transactions…");
    const batch = await fetchRound(run, planHash).catch(async (error: unknown) => {
      if (await mergeExplainsMissingAccount(run, error)) return null;
      throw error;
    });
    if (!batch) return resultOf(run);
    const txs = [...batch.transactions].sort((a, b) => a.order - b.order);
    const { requiresAnotherCall, steps } = batch.remaining;
    if (requiresAnotherCall && txs.length === 0) {
      throw new CloseDidNotConvergeError(round + 1, run.maxRounds ?? bound, "empty_batch");
    }
    await processTxs(run, txs, requiresAnotherCall);
    if (!requiresAnotherCall) return resultOf(run);
    bound = Math.max(bound, Math.min(HARD_MAX_ROUNDS, round + 1 + steps + ROUND_MARGIN));
  }

  throw new CloseDidNotConvergeError(run.maxRounds ?? bound, run.maxRounds ?? bound, "round_limit");
}

function resultOf(run: EngineRun): CloseRunResult {
  return { mergeConfirmed: run.confirmedMerge !== undefined };
}

type EngineRun = CloseEngineDeps & {
  /** The last merge this run saw through, with its client-side record. */
  confirmedMerge?: UnresolvedSubmission;
};

/** Settles a left-over submission. Only a confirmed one moves the account on from the reviewed
 *  plan: one that expired never ran, so its round is still checked against that plan. */
async function settleLeftOver(
  reconcile: CloseReconciliation,
  submission: UnresolvedSubmission
): Promise<"closed" | "confirmed" | "expired"> {
  const settled = await resolveSubmission(submission, reconcile.lookup, reconcile.now);
  if (settled.outcome === "unknown") throw new CloseOutcomeUnknownError(submission);
  await reconcile.onSubmission?.(null);
  if (settled.outcome === "failed") {
    throw new CloseTransactionFailedError(submission, settled.message);
  }
  if (settled.outcome === "expired") return "expired";
  reconcile.onResolved?.(submission);
  return submissionClosesAccount(submission) ? "closed" : "confirmed";
}

/** `account_not_found` after a merge is the close having worked, but only a confirmed lookup of
 *  the merge's own hash says so: another transaction could have removed the account. */
async function mergeExplainsMissingAccount(run: EngineRun, error: unknown): Promise<boolean> {
  if (!hasCode(error, "account_not_found") || !run.reconcile || !run.confirmedMerge) return false;
  const settled = await resolveSubmission(
    run.confirmedMerge,
    run.reconcile.lookup,
    run.reconcile.now
  );
  return settled.outcome === "confirmed";
}

/** The API re-reads and re-plans on every call, so a round refused because the account moved
 *  under the read is asked for again, a bounded number of times and after a pause. Not when it
 *  was checked against the reviewed plan: that plan is what is stale, and only a new review
 *  replaces it. */
async function fetchRound(
  deps: CloseEngineDeps,
  planHash: string | undefined
): Promise<TransactionsResponse> {
  for (let attempt = 0; ; attempt++) {
    if (attempt > 0) await (deps.sleep ?? defaultSleep)(STATE_CHANGED_REFETCH_DELAY_MS);
    try {
      return await deps.getTransactions(planHash === undefined ? {} : { planHash });
    } catch (error) {
      if (!hasCode(error, "state_changed")) throw error;
      if (planHash !== undefined || attempt === STATE_CHANGED_REFETCHES) {
        throw new CloseStateChangedError(error);
      }
    }
  }
}

async function processTxs(
  deps: EngineRun,
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
  deps: EngineRun,
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
  const finalXdr = deps.prepare ? await deps.prepare(tx, signedXdr) : signedXdr;
  if (!deps.reconcile) {
    deps.onConfirmed?.(tx, await deps.submit(tx, finalXdr));
    return;
  }
  const submission = openSubmission(deps.reconcile, tx, finalXdr);
  await deps.reconcile.onSubmission?.(submission);
  await submitUntilSettled(deps, deps.reconcile, tx, finalXdr, submission);
  await deps.reconcile.onSubmission?.(null);
  if (submissionClosesAccount(submission)) deps.confirmedMerge = submission;
  deps.onConfirmed?.({ ...tx, covers: submission.covers }, submission.hash);
}

function openSubmission(
  reconcile: CloseReconciliation,
  tx: CloseTransaction,
  finalXdr: string
): UnresolvedSubmission {
  const claimed = tx.covers.filter((s) => s !== "MERGE" && s !== "CLOSE_ACCOUNT");
  return {
    hash: reconcile.hashOf(finalXdr),
    covers: reconcile.closesAccount(finalXdr) ? [...claimed, "MERGE", "CLOSE_ACCOUNT"] : claimed,
    validUntil: reconcile.validUntil(finalXdr),
    ...(tx.coversTargets && { coversTargets: tx.coversTargets }),
    ...(tx.needsSponsoredFee && { needsSponsoredFee: true }),
  };
}

/** Returns only once the client's own hash is confirmed. A hash the API answers with is compared
 *  and never adopted. Every send is `finalXdr` itself, so nothing here can ask for a signature. */
async function submitUntilSettled(
  deps: EngineRun,
  reconcile: CloseReconciliation,
  tx: CloseTransaction,
  finalXdr: string,
  submission: UnresolvedSubmission
): Promise<void> {
  for (let attempt = 0; attempt <= SUBMIT_RESEND_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      deps.onProgress?.("Still waiting for the network to confirm…");
      await (deps.sleep ?? defaultSleep)(SUBMIT_RESEND_DELAY_MS);
    }
    try {
      if ((await deps.submit(tx, finalXdr)) === submission.hash) return;
    } catch (error) {
      if (!isSubmitRefused(error)) continue;
      if (attempt === 0) {
        await reconcile.onSubmission?.(null);
        throw error;
      }
      break;
    }
  }
  const settled = await resolveSubmission(submission, reconcile.lookup, reconcile.now);
  if (settled.outcome === "confirmed") return;
  if (settled.outcome === "failed") {
    await reconcile.onSubmission?.(null);
    throw new CloseTransactionFailedError(submission, settled.message);
  }
  throw new CloseOutcomeUnknownError(submission);
}
