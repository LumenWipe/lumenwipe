import "server-only";
import {
  Keypair,
  Networks,
  StrKey,
  Transaction,
  TransactionBuilder,
  type Memo,
  type MemoType,
} from "@stellar/stellar-sdk";
import { parseStroops } from "./stroops";
import { PlaygroundVerificationError } from "./verify-error";

// The playground's own rules for a close into the exchange stand-in, run alongside the shared
// verifier (lib/verify.ts runs these first, then `@lumenwipe/verify`; both must pass). They restate
// the web anchor's relay rule in the playground's terms and hold it to the session record: the
// stand-in, the memo the session drew, and the balance the playground read from Horizon itself in
// the round that signs the merge. Nothing is taken from the API's response.
//
// - The hand-off is exactly two operations: the merge, sourced from the demo, into an account
//   that is none of the session's own, then a payment sent by that same account (the relay) to
//   the session's stand-in, in XLM, for no less than the recorded balance less 0.01 XLM and no
//   more than the recorded balance, with the session's memo, value and type.
// - Any other transaction of the session (the cleanup, or a claim, signer or exit round) neither
//   merges nor carries a memo. lib/verify.ts holds the cleanup to the operation cap and the
//   recorded amounts as well.
// - A merge straight into the stand-in is refused: an exchange cannot credit a merge.
//
// `assertCosignedEnvelope` then holds the envelope the API's mediator returns to the one the
// playground signed, and `assertDeliveredOnLedger` checks the confirmed transaction read back by
// its hash.

/** The mediator key this deployment expects the API's co-signature from, from its configuration
 *  and never from the API: the mediator check does not report it, and the sign response is what
 *  it checks. */
export const EXPECTED_MEDIATOR_ENV = "PLAYGROUND_EXPECTED_MEDIATOR_TESTNET";

/** A configured mediator key: a valid account public key, or null for anything else. */
export function parseExpectedMediator(raw: string | undefined): string | null {
  const value = raw?.trim() ?? "";
  return StrKey.isValidEd25519PublicKey(value) ? value : null;
}

/** The mediator key this deployment expects, read on each request. */
export function expectedMediator(): string | null {
  return parseExpectedMediator(process.env[EXPECTED_MEDIATOR_ENV]);
}

/** How far under the recorded balance the forward may fall: the web anchor's 0.01 XLM, which
 *  covers the fee the merge transaction consumes. */
export const FORWARD_TOLERANCE_STROOPS = BigInt(100_000);

/** What an exchange session's close may do, from the session record and this round's read. */
export interface ExchangeExpectation {
  /** The bundled registry's stand-in the session recorded. */
  destination: string;
  /** The session's deposit memo, a uint64 in decimal. */
  memo: string;
  memoType: "id";
  /** The demo's XLM, read from Horizon by the playground in this round, or null when it has not
   *  been read: then no merge is signed. */
  recordedBalance: string | null;
  /** Every account the session holds a key for or names (the demo, the market maker, the
   *  issuers, the recipient and the helpers): none of them may be the relay. */
  sessionAccounts: readonly string[];
}

const refuse = (code: string): never => {
  throw new PlaygroundVerificationError(code);
};

function stroopsOf(amount: string, code: string): bigint {
  const stroops = parseStroops(amount);
  if (stroops === null) return refuse(code);
  return stroops;
}

/** The least the forward may carry: the recorded balance less the tolerance. */
export function forwardFloorStroops(recordedBalance: string): bigint {
  return stroopsOf(recordedBalance, "exchange_balance_unreadable") - FORWARD_TOLERANCE_STROOPS;
}

/** The memo's value as text: an id memo's is already its decimal string. */
function memoValue(memo: Memo<MemoType>): string | null {
  const { value } = memo;
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : Buffer.from(value).toString("utf8");
}

/** The transaction carries the session's memo: an id memo with exactly its value. A text memo
 *  of the same digits is a different memo, and an exchange that credits by id ignores it. */
function assertSessionMemo(memo: Memo<MemoType>, exchange: ExchangeExpectation): void {
  if (memo.type === "none") refuse("exchange_memo_missing");
  if (memo.type !== exchange.memoType) refuse("exchange_memo_type_mismatch");
  if (memoValue(memo) !== exchange.memo) refuse("exchange_memo_value_mismatch");
}

/** The two-operation hand-off: a merge, then whatever follows it. Any other transaction of an
 *  exchange session is held to the rules of one that does not merge. */
export function isRelayHandOff(tx: Transaction): boolean {
  return tx.operations.length === 2 && tx.operations[0]!.type === "accountMerge";
}

function assertHandOff(tx: Transaction, demoPublic: string, exchange: ExchangeExpectation): void {
  const [merge, forward] = tx.operations;
  if (merge?.type !== "accountMerge" || forward?.type !== "payment") {
    return refuse("exchange_handoff_shape");
  }
  if (tx.source !== demoPublic || (merge.source ?? tx.source) !== demoPublic) {
    refuse("exchange_merge_source_mismatch");
  }
  const relay = merge.destination;
  if (!StrKey.isValidEd25519PublicKey(relay)) refuse("exchange_relay_not_account");
  if (exchange.sessionAccounts.includes(relay)) refuse("exchange_relay_is_session_account");
  // The account the merge just paid into is the one paying the balance on, in the same
  // transaction: the relay is a conduit, never a destination.
  if (forward.source !== relay) refuse("exchange_forward_source_mismatch");
  // The session's stand-in, never the merge's destination or anything the API names.
  if (forward.destination !== exchange.destination) {
    refuse("exchange_forward_destination_mismatch");
  }
  if (!forward.asset.isNative()) refuse("exchange_forward_not_native");
  if (exchange.recordedBalance === null) return refuse("exchange_balance_not_recorded");
  const amount = stroopsOf(forward.amount, "exchange_forward_unreadable");
  if (amount < forwardFloorStroops(exchange.recordedBalance)) refuse("exchange_forward_short");
  if (amount > stroopsOf(exchange.recordedBalance, "exchange_balance_unreadable")) {
    refuse("exchange_forward_above_balance");
  }
  assertSessionMemo(tx.memo, exchange);
}

/**
 * Holds one transaction of an exchange session to the playground's relay rules. Returns nothing;
 * throws a `PlaygroundVerificationError` on the first rule broken. Run before the shared
 * verifier, so these refusals are the playground's own.
 */
export function assertExchangeTransaction(
  tx: Transaction,
  demoPublic: string,
  exchange: ExchangeExpectation
): void {
  const merges = tx.operations.filter((op) => op.type === "accountMerge");
  if (merges.some((op) => op.destination === exchange.destination)) {
    refuse("exchange_direct_merge_refused");
  }
  if (isRelayHandOff(tx)) {
    assertHandOff(tx, demoPublic, exchange);
    return;
  }
  // Anything else is a round before the hand-off: the balance leaves only through it.
  if (merges.length > 0) refuse("exchange_cleanup_merges");
  if (tx.memo.type !== "none") refuse("exchange_cleanup_memo");
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

/**
 * Holds the envelope the API's mediator returns to the transaction the playground signed: the
 * same transaction (its hash unchanged), every signature it carried, and exactly one more, which
 * verifies against `mediatorKey`, the key this deployment's configuration names.
 */
export function assertCosignedEnvelope(
  signedXdr: string,
  cosignedXdr: string,
  mediatorKey: string
): void {
  const signed = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET);
  let cosigned: ReturnType<typeof TransactionBuilder.fromXDR>;
  try {
    cosigned = TransactionBuilder.fromXDR(cosignedXdr, Networks.TESTNET);
  } catch {
    return refuse("exchange_cosign_unreadable");
  }
  if (!(cosigned instanceof Transaction) || !(signed instanceof Transaction)) {
    return refuse("exchange_cosign_not_transaction");
  }
  const hash = cosigned.hash();
  if (hex(hash) !== hex(signed.hash())) refuse("exchange_cosign_hash_changed");
  if (cosigned.signatures.length !== signed.signatures.length + 1) {
    refuse("exchange_cosign_signature_count");
  }
  const added = cosigned.signatures.map((s) => s.toXdr("base64"));
  for (const sig of signed.signatures) {
    const at = added.indexOf(sig.toXdr("base64"));
    if (at === -1) refuse("exchange_cosign_signature_dropped");
    added.splice(at, 1);
  }
  const mediator = Keypair.fromPublicKey(mediatorKey);
  const extra = cosigned.signatures.find((s) => s.toXdr("base64") === added[0]);
  if (!extra || !mediator.verify(hash, extra.signature)) refuse("exchange_cosign_not_mediator");
}

/** A confirmed transaction as the network reports it, read by its hash. */
export interface LedgerTransaction {
  successful: boolean;
  envelopeXdr: string;
}

/**
 * Checks what the network applied for the merge's hash: a successful transaction with the
 * session's id memo, whose relay (the account the demo merged into) paid the session's stand-in
 * at least the recorded balance less the tolerance, in XLM.
 */
export function assertDeliveredOnLedger(
  ledger: LedgerTransaction,
  demoPublic: string,
  exchange: ExchangeExpectation
): void {
  if (!ledger.successful) refuse("exchange_delivery_failed");
  let tx: ReturnType<typeof TransactionBuilder.fromXDR>;
  try {
    tx = TransactionBuilder.fromXDR(ledger.envelopeXdr, Networks.TESTNET);
  } catch {
    return refuse("exchange_delivery_unreadable");
  }
  if (!(tx instanceof Transaction)) return refuse("exchange_delivery_unreadable");
  if (tx.memo.type !== "id" || memoValue(tx.memo) !== exchange.memo) {
    refuse("exchange_delivery_memo_mismatch");
  }
  if (exchange.recordedBalance === null) return refuse("exchange_balance_not_recorded");
  const floor = forwardFloorStroops(exchange.recordedBalance);
  const merge = tx.operations.find(
    (op) => op.type === "accountMerge" && (op.source ?? tx.source) === demoPublic
  );
  const relay = merge?.type === "accountMerge" ? merge.destination : null;
  const delivered = tx.operations.some(
    (op) =>
      op.type === "payment" &&
      relay !== null &&
      op.source === relay &&
      op.destination === exchange.destination &&
      op.asset.isNative() &&
      (parseStroops(op.amount) ?? BigInt(0)) >= floor
  );
  if (!delivered) refuse("exchange_delivery_payment_missing");
}
