import "server-only";
import {
  FeeBumpTransaction,
  Keypair,
  Transaction,
  TransactionBuilder,
  Networks,
} from "@stellar/stellar-sdk";
import {
  CloseDidNotConvergeError,
  LumenWipeApiError,
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
import {
  loadLedgerTransaction,
  loadNativeBalance,
  loadSignerState,
  type SignerState,
} from "./horizon-submit";
import { logEntryOf, type DemolishLogEntry, type PendingDemolishTx } from "./session-store";
import { requiredWeight, signForWeight, type SigningKey } from "./signing";
import {
  closeDestination,
  FEE_ACCOUNT_NOT_CONFIGURED,
  PlaygroundVerificationError,
  verifyDemolishTransaction,
  withRecordedBalance,
  type PlaygroundCloseExpectation,
} from "./verify";
import { assertSponsoredEnvelope } from "./verify-feebump";
import {
  assertCosignedEnvelope,
  assertDeliveredOnLedger,
  type LedgerTransaction,
} from "./verify-mediator";

/** The calls a demolish round makes to the LumenWipe API; `LumenWipeClient` provides them. */
export interface DemolishApi {
  closePlan(
    body: ClosePlanRequest
  ): Promise<{ decisionPoints: DecisionPoint[]; blockers: { code: string }[] }>;
  closeTransactions(body: CloseTransactionsRequest): Promise<TransactionsResponse>;
  submit(signedXdr: string): Promise<{ hash: string }>;
  getTransaction(hash: string): Promise<TransactionLookupResponse>;
  /** Wraps a signed transaction whose own fee is zero in the API sponsor's fee-bump envelope. */
  feeBumpSponsor(signedXdr: string): Promise<{ transaction: string }>;
  /** Adds the API mediator's signature to a signed relay hand-off. */
  mediatorSign(signedXdr: string): Promise<{ transaction: string }>;
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

/** What a round reads from the network itself, never from the API. */
export interface DemolishChain {
  /** The demo's live signers and thresholds, which the signing weight is judged against. */
  signerState: (address: string) => Promise<SignerState>;
  /** The demo's XLM balance, which an exchange session's forward is held to. */
  nativeBalance: (address: string) => Promise<string>;
  /** A transaction the network applied, by its hash; null while the network does not know it. */
  ledgerTransaction: (hash: string) => Promise<LedgerTransaction | null>;
}

export interface RunDemolishOptions {
  demoKeypair: Keypair;
  /** The recorded signers the playground can sign for, decrypted for this round only. */
  signingKeys: SigningKey[];
  /** What the close may do, from the session record (`expectationFromSession`). */
  expected: PlaygroundCloseExpectation;
  /** The API mediator's public key, from this deployment's configuration, which an exchange
   *  session's co-signature must verify against; null when none is configured. */
  mediatorKey: string | null;
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

/**
 * A sponsored close's fee was not paid: the API's sponsor refused the signed transaction, the API
 * built none for an account that cannot pay its own, or this deployment has no fee account to check
 * the sponsor's envelope against. Nothing was sent. `code` is for the log only.
 */
export class DemolishFeeUnsponsoredError extends Error {
  constructor(readonly code: string) {
    super("The close's fee was not sponsored");
    this.name = "DemolishFeeUnsponsoredError";
  }
}

/**
 * An exchange session's merge confirmed, but the ledger did not show the stand-in paid with the
 * session's memo: the transaction could not be read back, or it is not the one checked before
 * signing. The account is merged either way. `code` is for the log only.
 */
export class DemolishDeliveryUnconfirmedError extends Error {
  constructor(readonly code: string) {
    super("The exchange deposit could not be confirmed on the ledger");
    this.name = "DemolishDeliveryUnconfirmedError";
  }
}

/** An exchange session's hand-off, with no mediator key configured to check the co-signature
 *  against: refused before the demo key signs it. */
export const MEDIATOR_NOT_CONFIGURED = "exchange_mediator_not_configured";

/** Reads of a confirmed hand-off before it counts as not found: Horizon trails the API's
 *  confirmation by about a ledger. */
const DELIVERY_READ_ATTEMPTS = 6;
const DELIVERY_READ_DELAY_MS = 2_000;

/** Plan blockers the close cannot build past, which stop the round before anything is built. */
export class DemolishBlockedError extends Error {
  constructor(readonly blockers: string[]) {
    super("The close reported a blocker");
    this.name = "DemolishBlockedError";
  }
}

/**
 * The one plan blocker a playground close builds past: a balance the session answered `forfeit`,
 * which stays unclaimed after the merge by the session's own choice.
 */
const PASSABLE_BLOCKERS: ReadonlySet<string> = new Set(["claimable_balance_forfeited"]);

/** The API's claimable-balance decision id (decisions.ts `claimableBalanceDecisionId`). */
const claimDecisionId = (balanceId: string): string => `claim:${balanceId}`;

/** The session's answer for a recorded balance, or null for one it never recorded. */
function claimChoice(balanceId: string, expected: PlaygroundCloseExpectation): string | null {
  const claim = expected.claims.find((c) => c.id === balanceId);
  if (claim) return claim.addTrustline ? "add_trustline_then_claim" : "claim";
  return expected.forfeits.includes(balanceId) ? "forfeit" : null;
}

/**
 * The answers the plan itself needs to see the account as the close will leave it: the destination
 * acknowledgement and a choice for every balance the session recorded, so a balance claimed
 * through a new trustline already has its asset's disposition asked for.
 */
export function planAnswers(expected: PlaygroundCloseExpectation): DecisionAnswer[] {
  const ids = [...expected.claims.map((c) => c.id), ...expected.forfeits];
  return [
    ...destinationAnswers(expected),
    ...ids.flatMap((id) => {
      const choice = claimChoice(id, expected);
      return choice ? [{ id: claimDecisionId(id), choice }] : [];
    }),
  ];
}

/**
 * The acknowledgement that the destination is an account the session controls: true of the market
 * maker, and never given for the exchange stand-in, which the registry lists and nobody controls.
 */
function destinationAnswers(expected: PlaygroundCloseExpectation): DecisionAnswer[] {
  if (expected.exchange) return [];
  return [{ id: destinationDecisionId(expected.sinkPublic), choice: DESTINATION_ACK_CHOICE }];
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
  const answers: DecisionAnswer[] = destinationAnswers(expected);
  const unanswerable: string[] = [];
  for (const dp of decisionPoints) {
    if (dp.id === destinationId) continue;
    let answer: DecisionAnswer | null = null;
    if (dp.type === "claimable_balance") {
      const { balanceId } = dp.subject;
      if (typeof balanceId === "string" && dp.id === claimDecisionId(balanceId)) {
        const choice = claimChoice(balanceId, expected);
        if (choice) answer = { id: dp.id, choice };
      }
    } else if (dp.type === "asset_disposition") {
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

function parseEnvelope(xdr: string): Transaction | FeeBumpTransaction {
  return TransactionBuilder.fromXdr(xdr, Networks.TESTNET);
}

/** A transaction the API built and the playground signs: never a fee-bump envelope. */
function parseOwn(xdr: string): Transaction {
  const parsed = parseEnvelope(xdr);
  if (!(parsed instanceof Transaction)) {
    throw new Error("Unexpected fee-bump transaction from the API");
  }
  return parsed;
}

/** The transaction the playground signed, inside the sponsor's fee-bump envelope or on its own. */
function innerOf(xdr: string): Transaction {
  const parsed = parseEnvelope(xdr);
  return parsed instanceof FeeBumpTransaction ? parsed.innerTransaction : parsed;
}

/** The hash of the envelope itself, over the testnet passphrase: a fee-bump's outer hash, which is
 *  the one the network confirms, never its inner one. */
export function envelopeHash(xdr: string): string {
  return Buffer.from(parseEnvelope(xdr).hash()).toString("hex");
}

function closesAccount(xdr: string, demoPublic: string): boolean {
  const parsed = innerOf(xdr);
  return parsed.operations.some(
    (op) => op.type === "accountMerge" && (op.source ?? parsed.source) === demoPublic
  );
}

function validUntil(xdr: string): number | null {
  const maxTime = Number(innerOf(xdr).timeBounds?.maxTime ?? 0);
  return maxTime > 0 ? maxTime : null;
}

/**
 * The envelope a signed transaction is sent in: itself when it pays its own fee, or the API
 * sponsor's fee-bump envelope around it, held to the session's configured fee account, to the
 * transaction as approved (the engine has already checked `signedXdr` hashes to it) and to every
 * signature on it. Only a fee of zero, which lib/verify.ts admits only for a sponsored session,
 * goes to the sponsor.
 */
async function sponsoredIfUnpaid(
  client: Pick<DemolishApi, "feeBumpSponsor">,
  expected: PlaygroundCloseExpectation,
  signedXdr: string
): Promise<string> {
  const signed = parseOwn(signedXdr);
  if (signed.fee !== "0") return signedXdr;
  const feeAccount = expected.sponsorFeeAccount;
  if (feeAccount === null) throw new PlaygroundVerificationError("zero_fee_not_sponsored");
  let envelope: string;
  try {
    envelope = (await client.feeBumpSponsor(signedXdr)).transaction;
  } catch (err) {
    if (err instanceof LumenWipeApiError) throw new DemolishFeeUnsponsoredError(err.code);
    throw err;
  }
  assertSponsoredEnvelope(envelope, {
    feeAccount,
    approvedHash: envelopeHash(signedXdr),
    signatureCount: signed.signatures.length,
  });
  return envelope;
}

/**
 * The envelope an exchange session's hand-off is sent in: the one the playground signed with the
 * API mediator's signature added, and nothing else changed (./verify-mediator).
 */
async function cosigned(
  client: Pick<DemolishApi, "mediatorSign">,
  mediatorKey: string | null,
  signedXdr: string
): Promise<string> {
  if (mediatorKey === null) throw new PlaygroundVerificationError(MEDIATOR_NOT_CONFIGURED);
  const envelope = (await client.mediatorSign(signedXdr)).transaction;
  assertCosignedEnvelope(signedXdr, envelope, mediatorKey);
  return envelope;
}

/**
 * Reads a confirmed hand-off back by its hash and holds it to the session: the id memo it drew,
 * and the stand-in paid by the relay at least the balance recorded for that round.
 */
async function confirmDelivery(
  chain: DemolishChain,
  hash: string,
  expected: PlaygroundCloseExpectation,
  recordedBalance: string | null,
  sleep: (ms: number) => Promise<void>
): Promise<void> {
  const { exchange } = expected;
  if (!exchange) return;
  let ledger: LedgerTransaction | null = null;
  for (let attempt = 0; attempt < DELIVERY_READ_ATTEMPTS && !ledger; attempt++) {
    if (attempt > 0) await sleep(DELIVERY_READ_DELAY_MS);
    ledger = await chain.ledgerTransaction(hash);
  }
  if (!ledger) throw new DemolishDeliveryUnconfirmedError("exchange_delivery_not_found");
  try {
    assertDeliveredOnLedger(ledger, expected.demoPublic, { ...exchange, recordedBalance });
  } catch (err) {
    if (err instanceof PlaygroundVerificationError) {
      throw new DemolishDeliveryUnconfirmedError(err.message);
    }
    throw err;
  }
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
 * instead of a browser wallet. A transaction left at a fee of zero goes to the API's fee sponsor
 * after it is signed, and its fee-bump envelope is checked (./verify-feebump) before it is sent.
 *
 * One round per call keeps each request far inside its time limit, and the API is stateless, so the
 * next call carries on from live state. What it cannot see is a transaction already sent whose
 * outcome is unknown: that one is recorded through `hooks.persistPending` before it is sent, and the
 * next round settles it by hash (`reconcile.unresolved`) before it asks the API for anything, so a
 * confirmed transaction is never built or sent twice.
 */
export async function runCloseRound(
  client: DemolishApi,
  chain: DemolishChain,
  opts: RunDemolishOptions,
  sleep?: (ms: number) => Promise<void>
): Promise<DemolishRoundResult> {
  const { hooks } = opts;
  const demoPublic = opts.demoKeypair.publicKey();
  const destination = closeDestination(opts.expected);
  const exchange = opts.expected.exchange;
  // An exchange session's close carries its memo; any other carries none.
  const memo = exchange ? { memo: exchange.memo, memoType: exchange.memoType } : {};
  // This round's expectation: an exchange session's carries the balance read below, so a forward
  // is held to what the playground saw on the network, never to the API's figure.
  let expected = opts.expected;
  // The merge that confirmed, and the balance its round recorded, for the delivery read.
  const outcome: { merged: { hash: string; recordedBalance: string | null } | null } = {
    merged: null,
  };

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
  // The demo's signers and thresholds, read after each build: a signer removal that confirmed in an
  // earlier round changes what the next transaction needs.
  let signers: SignerState | undefined;
  const liveSigners = (): SignerState => {
    if (!signers) throw new Error("No signer state was read for this round");
    return signers;
  };

  const deps: CloseEngineDeps = {
    getTransactions: async () => {
      if (!decisions) {
        const plan = await client.closePlan({
          source: demoPublic,
          destination,
          decisions: planAnswers(opts.expected),
        });
        const stops = plan.blockers.map((b) => b.code).filter((c) => !PASSABLE_BLOCKERS.has(c));
        if (stops.length > 0) throw new DemolishBlockedError(stops);
        const built = buildDemolishDecisions(plan.decisionPoints, opts.expected);
        if (built.unanswerable.length > 0) {
          throw new DemolishDecisionUnanswerableError(built.unanswerable);
        }
        decisions = built.answers;
      }
      let res: TransactionsResponse;
      try {
        res = await client.closeTransactions({
          source: demoPublic,
          destination,
          decisions,
          ...memo,
        });
      } catch (err) {
        // A drained demo can only close sponsored: an API that will not sponsor it says it is short.
        if (
          opts.expected.sponsored &&
          err instanceof LumenWipeApiError &&
          err.code === "close_fee_balance_short"
        ) {
          throw new DemolishFeeUnsponsoredError(err.code);
        }
        throw err;
      }
      remaining = res.remaining;
      signers = await chain.signerState(demoPublic);
      if (exchange)
        expected = withRecordedBalance(opts.expected, await chain.nativeBalance(demoPublic));
      return res;
    },
    verify: (tx: CloseTransaction) => {
      try {
        verifyDemolishTransaction(tx, expected);
        // Every rule held, but the mediator's signature could not be checked: nothing is signed.
        if (exchange && closesAccount(tx.xdr, demoPublic) && opts.mediatorKey === null) {
          throw new PlaygroundVerificationError(MEDIATOR_NOT_CONFIGURED);
        }
      } catch (err) {
        // Every other rule held; only the sponsor's envelope could not be checked. Nothing is
        // signed, and the close goes on once the demo can pay its own fee.
        if (
          err instanceof PlaygroundVerificationError &&
          err.message === FEE_ACCOUNT_NOT_CONFIGURED
        ) {
          throw new DemolishFeeUnsponsoredError(FEE_ACCOUNT_NOT_CONFIGURED);
        }
        throw err;
      }
    },
    // Pins each verified transaction's hash, so what is signed and handed to `prepare` is checked
    // against it. A fee-bump envelope is never unwrapped here.
    transactionHash: envelopeHash,
    requiredWeight: (tx) => requiredWeight(parseOwn(tx.xdr), liveSigners()),
    // Only the demo key and the session's own recorded signers ever sign. The engine compares the
    // weight returned here with `requiredWeight` and refuses to submit a transaction short of it.
    sign: async (tx, xdr) => {
      const parsed = parseOwn(xdr);
      const state = liveSigners();
      const weight = signForWeight(
        parsed,
        opts.demoKeypair,
        opts.signingKeys,
        state,
        requiredWeight(parsed, state)
      );
      signing = tx;
      return { xdr: parsed.toEnvelope().toXdr("base64"), weight };
    },
    // An exchange session's hand-off goes to the API's mediator for its co-signature, checked
    // before it is sent; any other transaction goes to the sponsor only when its fee is zero.
    prepare: (_tx, xdr) =>
      exchange && closesAccount(xdr, demoPublic)
        ? cosigned(client, opts.mediatorKey, xdr)
        : sponsoredIfUnpaid(client, opts.expected, xdr),
    submit: async (_tx, xdr) => {
      const res = await client.submit(xdr);
      return res.hash;
    },
    reconcile: {
      hashOf: envelopeHash,
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
          recordedBalance: expected.exchange?.recordedBalance ?? null,
        });
      },
      ...(hooks.pending && { unresolved: submissionOf(hooks.pending) }),
      onResolved: (submission) => {
        const left = hooks.pending;
        if (left && left.hash === submission.hash) {
          const closes = submissionClosesAccount(submission);
          if (closes) outcome.merged = { hash: left.hash, recordedBalance: left.recordedBalance };
          hooks.onConfirmed(logEntryOf(left), closes);
        }
      },
    },
    onConfirmed: (tx, hash) => {
      const closes = tx.covers.includes("MERGE");
      // Read from the envelope the playground verified, not from what the API says it covers.
      if (closesAccount(tx.xdr, demoPublic)) {
        outcome.merged = { hash, recordedBalance: expected.exchange?.recordedBalance ?? null };
      }
      hooks.onConfirmed(
        { txId: tx.id, hash, summary: tx.intent.summary, operations: tx.intent.operations },
        closes
      );
    },
    // One round per request; the client calls again while `done` is false.
    maxRounds: 1,
    ...(sleep && { sleep }),
  };

  try {
    const { mergeConfirmed } = await runClose(deps);
    if (!mergeConfirmed) throw new Error("The close ended without a confirmed merge");
    const confirmed = outcome.merged;
    if (exchange) {
      if (!confirmed) throw new DemolishDeliveryUnconfirmedError("exchange_merge_hash_unknown");
      await confirmDelivery(
        chain,
        confirmed.hash,
        opts.expected,
        confirmed.recordedBalance,
        sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
      );
    }
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
      feeBumpSponsor: (signedXdr) => client.feeBumpSponsor(signedXdr),
      mediatorSign: (signedXdr) => client.mediatorSign(signedXdr),
    },
    {
      signerState: loadSignerState,
      nativeBalance: async (address) => (await loadNativeBalance(address)).balance,
      ledgerTransaction: loadLedgerTransaction,
    },
    opts
  );
}
