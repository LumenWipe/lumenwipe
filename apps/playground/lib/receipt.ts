import "server-only";
import {
  FeeBumpTransaction,
  Networks,
  StrKey,
  Transaction,
  TransactionBuilder,
  extractBaseAddress,
  xdr,
} from "@stellar/stellar-sdk";
import type { TransactionRecord } from "./horizon-submit";
import { parseStroops } from "./stroops";

// A confirmed close transaction's receipt, read only from what the network recorded: its fee from
// the result, its merge amount from the merge operation's own result, never from an estimate.

/** Where a merge sent the account's XLM. A relay is never named: it forwards to the exchange. */
export type ReceiptMerge =
  | { into: "destination"; amountStroops: string; destination: string }
  | {
      into: "relay";
      amountStroops: string;
      forwarded: { amountStroops: string; to: string; memo: string | null };
    };

export type TxReceipt =
  | {
      hash: string;
      status: "read";
      feeStroops: string;
      feePaidBy: "account" | "sponsor";
      operations: { type: string; count: number }[];
      merge: ReceiptMerge | null;
    }
  | { hash: string; status: "failed"; feeStroops: string; feePaidBy: "account" | "sponsor" }
  | { hash: string; status: "pending" | "unavailable" };

type ResultWire = ReturnType<xdr.TransactionResult["toXdrObject"]>;
type OpResultWire = ReturnType<xdr.OperationResult["toXdrObject"]>;

/** The result codes of a successful transaction, and of a successful fee bump around one. */
const TX_SUCCESS = 0;
const TX_FEE_BUMP_INNER_SUCCESS = 1;
const OP_INNER = 0;
const ACCOUNT_MERGE = 8;
const ACCOUNT_MERGE_SUCCESS = 0;

const base = (address: string): string =>
  StrKey.isValidMed25519PublicKey(address) ? extractBaseAddress(address) : address;

function opResults(result: ResultWire): OpResultWire[] | null {
  const outcome = result.result;
  if (outcome.code === TX_SUCCESS) return outcome.results;
  if (outcome.code === TX_FEE_BUMP_INNER_SUCCESS) {
    const inner = outcome.innerResultPair.result.result;
    return inner.code === TX_SUCCESS ? inner.results : null;
  }
  return null;
}

function mergeAmount(result: OpResultWire | undefined): bigint | null {
  if (!result || result.code !== OP_INNER) return null;
  const tr = result.tr;
  if (tr.type !== ACCOUNT_MERGE) return null;
  const merge = tr.accountMergeResult;
  return merge.code === ACCOUNT_MERGE_SUCCESS ? merge.sourceAccountBalance : null;
}

function memoOf(tx: Transaction): string | null {
  const { value } = tx.memo;
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : Buffer.from(value).toString("utf8");
}

function readMerge(
  tx: Transaction,
  results: OpResultWire[],
  account: string
): ReceiptMerge | null | "mismatch" {
  const sourceOf = (op: Transaction["operations"][number]): string => base(op.source ?? tx.source);
  const at = tx.operations.findIndex(
    (op) => op.type === "accountMerge" && sourceOf(op) === account
  );
  if (at === -1) return null;
  const merge = tx.operations[at];
  const amount = mergeAmount(results[at]);
  if (merge?.type !== "accountMerge" || amount === null) return "mismatch";
  const into = base(merge.destination);
  const forward = tx.operations.find(
    (op) => op.type === "payment" && sourceOf(op) === into && op.asset.isNative()
  );
  if (forward?.type !== "payment") {
    return { into: "destination", amountStroops: amount.toString(), destination: into };
  }
  const forwarded = parseStroops(forward.amount);
  if (forwarded === null) return "mismatch";
  return {
    into: "relay",
    amountStroops: amount.toString(),
    forwarded: {
      amountStroops: forwarded.toString(),
      to: base(forward.destination),
      memo: memoOf(tx),
    },
  };
}

function countTypes(tx: Transaction): { type: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const op of tx.operations) counts.set(op.type, (counts.get(op.type) ?? 0) + 1);
  return [...counts].map(([type, count]) => ({ type, count }));
}

/**
 * The receipt for `hash`, from the record Horizon returned for it. The record must be the
 * transaction asked for (its own hash, or the inner hash of the fee bump it is) and must concern
 * the account; anything else reads as unavailable rather than as someone else's figures.
 */
export function readReceipt(record: TransactionRecord, hash: string, account: string): TxReceipt {
  const unavailable: TxReceipt = { hash, status: "unavailable" };
  let envelope: Transaction | FeeBumpTransaction;
  let result: ResultWire;
  try {
    envelope = TransactionBuilder.fromXDR(record.envelopeXdr, Networks.TESTNET);
    result = xdr.TransactionResult.fromXDR(record.resultXdr, "base64").toXdrObject();
  } catch {
    return unavailable;
  }
  const tx = envelope instanceof FeeBumpTransaction ? envelope.innerTransaction : envelope;
  const hashes = [Buffer.from(envelope.hash()).toString("hex")];
  if (envelope instanceof FeeBumpTransaction) hashes.push(Buffer.from(tx.hash()).toString("hex"));
  if (!hashes.includes(hash)) return unavailable;
  const concerns =
    base(tx.source) === account ||
    tx.operations.some((op) => op.source !== undefined && base(op.source) === account);
  if (!concerns) return unavailable;

  const feeStroops = result.feeCharged.toString();
  const payer = base(envelope instanceof FeeBumpTransaction ? envelope.feeSource : tx.source);
  const feePaidBy = payer === account ? "account" : "sponsor";
  const results = opResults(result);
  if (!record.successful || !results) return { hash, status: "failed", feeStroops, feePaidBy };
  if (results.length !== tx.operations.length) return unavailable;

  const merge = readMerge(tx, results, account);
  if (merge === "mismatch") return unavailable;
  return { hash, status: "read", feeStroops, feePaidBy, operations: countTypes(tx), merge };
}
