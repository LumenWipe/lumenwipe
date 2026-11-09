import "server-only";
import { Keypair, Transaction, TransactionBuilder, Networks } from "@stellar/stellar-sdk";
import {
  CloseDidNotConvergeError,
  LumenWipeClient,
  runClose,
  submissionClosesAccount,
  type ClosePlanRequest,
  type CloseEngineDeps,
  type CloseTransaction,
  type CloseTransactionsRequest,
  type DecisionAnswer,
  type DecisionPoint,
  type TransactionLookupResponse,
  type TransactionsResponse,
  type UnresolvedSubmission,
} from "@lumenwipe/sdk";
import { logEntryOf, type DemolishLogEntry, type PendingDemolishTx } from "./session-store";
import { verifyDemolishTransaction, type PlaygroundCloseExpectation } from "./verify";

/** The calls a demolish round makes to the LumenWipe API; `LumenWipeClient` provides them. */
export interface DemolishApi {
  closePlan(body: ClosePlanRequest): Promise<{ decisionPoints: DecisionPoint[] }>;
  closeTransactions(body: CloseTransactionsRequest): Promise<TransactionsResponse>;
  submit(signedXdr: string): Promise<{ hash: string }>;
  getTransaction(hash: string): Promise<TransactionLookupResponse>;
}

/** How a round reads and records the session's demolish progress (lib/session-actions.ts). */
export interface DemolishRoundHooks {
  /** A transaction an earlier round left in flight. It is settled by its hash before anything
   *  else, and never built or sent again. */
  pending: PendingDemolishTx | null;
  /** Records a transaction before it is sent. A rejection stops it unsent. */
  persistPending: (pending: PendingDemolishTx) => Promise<void>;
  /** The transaction in flight settled: confirmed (`onConfirmed` follows), refused, failed or
   *  expired. */
  settled: () => void;
  /** A transaction confirmed under the playground's own hash, from this round or a left-over one.
   *  `closesAccount` is parsed from the envelope the playground signed. */
  onConfirmed: (entry: DemolishLogEntry, closesAccount: boolean) => void;
}

export interface RunDemolishOptions {
  demoKeypair: Keypair;
  /** What the close may do, from the session record (`expectationFromSession`). */
  expected: PlaygroundCloseExpectation;
  apiUrl: string;
  apiKey: string;
  hooks: DemolishRoundHooks;
}

/** Where the close stands after one round. */
export interface DemolishRoundResult {
  /** The merge confirmed under the playground's own hash: the demo account is gone. */
  done: boolean;
  /** The API's estimate of the rounds still to run, when it gave one. */
  remainingSteps: number | null;
}

/**
 * The API's `destinationDecisionId` / `DESTINATION_ACK_CHOICE` (see
 * apps/api/src/lib/close-api/decisions.ts). Restated here rather than imported: apps/playground
 * must not import from apps/api, and these are part of the API's wire contract, not its internals.
 */
const destinationDecisionId = (address: string): string => `destination:${address}`;
const DESTINATION_ACK_CHOICE = "i_control_this_address";

/** The API's disposition choice ids (decisions.ts `resolveDispositions`, `TRANSFER_CHOICE`). */
const RETURN_TO_ISSUER_CHOICE = "return_to_issuer";
const CONVERT_CHOICE = "convert_to_xlm";
const TRANSFER_CHOICE = "transfer_to_account";
/** The API's `LEAVE_CHOICE`: a Soroban token balance stays with the closed address. */
const LEAVE_TOKEN_CHOICE = "acknowledge_residue";

/** Required decision points the playground has no answer for, which stop the close before it builds. */
export class DemolishDecisionUnanswerableError extends Error {
  constructor(readonly decisionIds: string[]) {
    super("The close needs a decision the playground cannot make");
    this.name = "DemolishDecisionUnanswerableError";
  }
}

export interface DemolishDecisions {
  answers: DecisionAnswer[];
  /** The ids of the required points left unanswered. */
  unanswerable: string[];
}

/**
 * The answer to one trustline's disposition, from the session's expectation: the choice the
 * session recorded for that exact asset (code and issuer), or a return to the issuer for any other
 * asset the session planned. Null for an asset the session never planned.
 */
function assetAnswer(
  id: string,
  asset: string,
  expected: PlaygroundCloseExpectation
): DecisionAnswer | null {
  const conversion = expected.conversions.find((c) => c.asset === asset);
  if (conversion) {
    // The floor travels with the answer, so the API refuses a route below it before building.
    return { id, choice: CONVERT_CHOICE, params: { minAmountOut: conversion.minAmountOut } };
  }
  const transfer = expected.transfers.find((t) => t.asset === asset);
  if (transfer) {
    return { id, choice: TRANSFER_CHOICE, params: { destination: transfer.destination } };
  }
  const planned = expected.assets.some(({ code, issuer }) => `${code}:${issuer}` === asset);
  return planned ? { id, choice: RETURN_TO_ISSUER_CHOICE } : null;
}

/**
 * Turns the plan's decision points into the answer set `close/transactions` requires.
 *
 * Every answer comes from the session's expectation, never from the plan's recommendation: a
 * trustline is converted, transferred to the session's recipient, or returned to its issuer as the
 * session chose, and a Soroban token someone dusted the demo with is left with the throwaway key.
 * A required point anything else asks for (an asset the session never planned, a claimable
 * balance, a confirmation the API added) is listed as unanswerable rather than guessed, so the
 * round stops and the page names it.
 */
export function buildDemolishDecisions(
  decisionPoints: DecisionPoint[],
  expected: PlaygroundCloseExpectation
): DemolishDecisions {
  const destinationId = destinationDecisionId(expected.sinkPublic);
  const answers: DecisionAnswer[] = [{ id: destinationId, choice: DESTINATION_ACK_CHOICE }];
  const unanswerable: string[] = [];
  for (const dp of decisionPoints) {
    if (dp.id === destinationId) continue;
    let answer: DecisionAnswer | null = null;
    if (dp.type === "asset_disposition") {
      // The point's own id already carries the API's encoding, so it is echoed back verbatim.
      const { kind, asset } = dp.subject;
      if (kind === "soroban_token") answer = { id: dp.id, choice: LEAVE_TOKEN_CHOICE };
      else if (kind === "trustline" && typeof asset === "string") {
        answer = assetAnswer(dp.id, asset, expected);
      }
    }
    if (answer) answers.push(answer);
    else if (dp.required) unanswerable.push(dp.id);
  }
  return { answers, unanswerable };
}

function parseOwn(xdr: string): Transaction {
  const parsed = TransactionBuilder.fromXdr(xdr, Networks.TESTNET);
  if (!(parsed instanceof Transaction)) {
    throw new Error("Unexpected fee-bump transaction from the API");
  }
  return parsed;
}

function closesAccount(xdr: string, demoPublic: string): boolean {
  const parsed = parseOwn(xdr);
  return parsed.operations.some(
    (op) => op.type === "accountMerge" && (op.source ?? parsed.source) === demoPublic
  );
}

function validUntil(xdr: string): number | null {
  const maxTime = Number(parseOwn(xdr).timeBounds?.maxTime ?? 0);
  return maxTime > 0 ? maxTime : null;
}

function submissionOf(pending: PendingDemolishTx): UnresolvedSubmission {
  return {
    hash: pending.hash,
    covers: pending.closesAccount ? ["MERGE"] : [],
    validUntil: pending.validUntil,
  };
}

/**
 * Runs one round of the real close engine against the demo account: the production `apps/api`
 * close/transactions -> submit loop, with the playground supplying its verify (`@lumenwipe/verify`
 * held to the session record, see ./verify) and sign (custodial, with the decrypted demo secret)
 * instead of a browser wallet.
 *
 * One round per call keeps each request far inside its time limit, and the API is stateless, so the
 * next call carries on from live state. What it cannot see is a transaction already sent whose
 * outcome is unknown: that one is recorded through `hooks.persistPending` before it is sent, and the
 * next round settles it by hash (`reconcile.unresolved`) before it asks the API for anything, so a
 * confirmed transaction is never built or sent twice.
 */
export async function runCloseRound(
  client: DemolishApi,
  opts: RunDemolishOptions,
  sleep?: (ms: number) => Promise<void>
): Promise<DemolishRoundResult> {
  const { hooks } = opts;
  const demoPublic = opts.demoKeypair.publicKey();
  const sinkPublic = opts.expected.sinkPublic;

  // The advisory read whose answer set every request of this round reuses. Deferred to the first
  // fetch: a left-over merge that confirmed ends the round before it, when the account is gone.
  // `close/plan` tolerates an empty `decisions` array - it reports what is unresolved instead of
  // refusing. `close/transactions` does NOT: an unrecognized destination is a 422
  // `destination_not_acknowledged`, and a funded trustline with no disposition a 422
  // `needs_decisions`. The API is stateless per round, so the full set travels on every call.
  let decisions: DecisionAnswer[] | undefined;
  let remaining: TransactionsResponse["remaining"] | undefined;
  // The transaction last signed, so the record written before it is sent can name it.
  let signing: CloseTransaction | undefined;

  const deps: CloseEngineDeps = {
    getTransactions: async () => {
      if (!decisions) {
        const plan = await client.closePlan({ source: demoPublic, destination: sinkPublic });
        const built = buildDemolishDecisions(plan.decisionPoints, opts.expected);
        if (built.unanswerable.length > 0) {
          throw new DemolishDecisionUnanswerableError(built.unanswerable);
        }
        decisions = built.answers;
      }
      const res = await client.closeTransactions({
        source: demoPublic,
        destination: sinkPublic,
        decisions,
      });
      remaining = res.remaining;
      return res;
    },
    verify: (tx: CloseTransaction) => {
      verifyDemolishTransaction(tx, opts.expected);
    },
    // The demo account is always single-sig from the master key's point of view:
    // ADD_SIGNER (mess step) only ever adds a co-signer, never raises the master
    // key's own weight requirement below what it already satisfies.
    requiredWeight: () => 1,
    sign: async (tx, xdr) => {
      const parsed = parseOwn(xdr);
      parsed.sign(opts.demoKeypair);
      signing = tx;
      return { xdr: parsed.toEnvelope().toXdr("base64"), weight: 1 };
    },
    submit: async (_tx, xdr) => {
      const res = await client.submit(xdr);
      return res.hash;
    },
    reconcile: {
      hashOf: (xdr) => Buffer.from(parseOwn(xdr).hash()).toString("hex"),
      closesAccount: (xdr) => closesAccount(xdr, demoPublic),
      validUntil,
      lookup: (hash) => client.getTransaction(hash),
      onSubmission: async (submission) => {
        if (!submission) {
          hooks.settled();
          return;
        }
        if (!signing) throw new Error("A submission opened with no signed transaction");
        await hooks.persistPending({
          txId: signing.id,
          hash: submission.hash,
          summary: signing.intent.summary,
          operations: signing.intent.operations,
          validUntil: submission.validUntil,
          closesAccount: submissionClosesAccount(submission),
        });
      },
      ...(hooks.pending && { unresolved: submissionOf(hooks.pending) }),
      onResolved: (submission) => {
        const left = hooks.pending;
        if (left && left.hash === submission.hash) {
          hooks.onConfirmed(logEntryOf(left), submissionClosesAccount(submission));
        }
      },
    },
    onConfirmed: (tx, hash) =>
      hooks.onConfirmed(
        { txId: tx.id, hash, summary: tx.intent.summary, operations: tx.intent.operations },
        tx.covers.includes("MERGE")
      ),
    // One round per request; the client calls again while `done` is false.
    maxRounds: 1,
    ...(sleep && { sleep }),
  };

  try {
    const { mergeConfirmed } = await runClose(deps);
    if (!mergeConfirmed) throw new Error("The close ended without a confirmed merge");
    return { done: true, remainingSteps: 0 };
  } catch (err) {
    if (
      err instanceof CloseDidNotConvergeError &&
      err.reason === "round_limit" &&
      remaining?.requiresAnotherCall
    ) {
      return { done: false, remainingSteps: remaining.steps };
    }
    throw err;
  }
}

/** One demolish round through the configured API. */
export function runDemolish(opts: RunDemolishOptions): Promise<DemolishRoundResult> {
  const client = new LumenWipeClient({
    baseUrl: opts.apiUrl,
    apiKey: opts.apiKey,
    network: "testnet",
  });
  return runCloseRound(
    {
      closePlan: (body) => client.closePlan(body),
      closeTransactions: (body) => client.closeTransactions(body),
      submit: (signedXdr) => client.submit(signedXdr),
      getTransaction: (hash) => client.getTransaction(hash),
    },
    opts
  );
}
