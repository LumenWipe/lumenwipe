import {
  FeeBumpTransaction,
  StrKey,
  TransactionBuilder,
  xdr,
  type rpc,
} from "@stellar/stellar-sdk";
import type { CloseDeliveredEntry, CloseDeliveredResponse } from "@lumenwipe/types";
import { NETWORK_PASSPHRASES, type Network } from "@/config/networks";

/** As many hashes as one batch close into a shared destination can produce. */
export const DELIVERED_MAX_HASHES = 20;

/** Lookups in flight at once, the same bound a batch plan uses. */
const DELIVERED_READ_CONCURRENCY = 5;

/** The fields of Horizon's `GET /transactions/{hash}` this reads. */
export interface HorizonTransactionRecord {
  successful: boolean;
  ledger: number;
  envelope_xdr: string;
  result_xdr: string;
}

/** Horizon's transaction by hash, or null when the provider does not hold it. */
export type HorizonTransactionReader = (hash: string) => Promise<HorizonTransactionRecord | null>;

/** A provider answered with something that cannot be the transaction asked for. Never an amount. */
export class DeliveredReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveredReadError";
  }
}

interface Seen {
  successful: boolean;
  ledger: number;
  envelope: string | xdr.TransactionEnvelope;
  result: string | xdr.TransactionResult;
}

/** The transaction whose operations ran: a fee-bump's inner one, or the envelope's own. */
interface Applied {
  source: string;
  operations: xdr.Operation[];
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

/** The G address behind a muxed account: an M address pays the same account. */
function accountOf(account: xdr.MuxedAccount): string {
  const key =
    account.type === "keyTypeEd25519" ? account.ed25519.value : account.med25519.ed25519.value;
  return StrKey.encodeEd25519PublicKey(Buffer.from(key));
}

function applied(envelope: xdr.TransactionEnvelope): Applied {
  switch (envelope.type) {
    case "envelopeTypeTx":
      return {
        source: accountOf(envelope.v1.tx.sourceAccount),
        operations: envelope.v1.tx.operations,
      };
    case "envelopeTypeTxV0":
      return {
        source: StrKey.encodeEd25519PublicKey(
          Buffer.from(envelope.v0.tx.sourceAccountEd25519.value)
        ),
        operations: envelope.v0.tx.operations,
      };
    case "envelopeTypeTxFeeBump": {
      const inner = envelope.feeBump.tx.innerTx.v1.tx;
      return { source: accountOf(inner.sourceAccount), operations: inner.operations };
    }
    default:
      throw new DeliveredReadError("The provider's envelope is of an unknown type.");
  }
}

/**
 * The applied transaction and its operation results, after checking that both belong to `hash`
 * on `network`. A fee-bump answers for its outer or its inner hash, and a provider may return the
 * fee-bump's own result or the inner one; either way the operations are the inner transaction's.
 */
function bind(
  hash: string,
  network: Network,
  seen: Seen
): { tx: Applied; succeeded: boolean; results: xdr.OperationResult[] } {
  let envelope: xdr.TransactionEnvelope;
  let result: xdr.TransactionResult;
  let outerHash: string;
  let innerHash: string | null;
  try {
    envelope =
      typeof seen.envelope === "string"
        ? xdr.TransactionEnvelope.fromXdr(seen.envelope, "base64")
        : seen.envelope;
    result =
      typeof seen.result === "string"
        ? xdr.TransactionResult.fromXdr(seen.result, "base64")
        : seen.result;
    const parsed = TransactionBuilder.fromXDR(envelope, NETWORK_PASSPHRASES[network]);
    outerHash = hex(parsed.hash());
    innerHash = parsed instanceof FeeBumpTransaction ? hex(parsed.innerTransaction.hash()) : null;
  } catch {
    throw new DeliveredReadError("The provider's transaction could not be decoded.");
  }
  if (hash !== outerHash && hash !== innerHash) {
    throw new DeliveredReadError("The provider answered with another transaction.");
  }
  const tx = applied(envelope);

  const body = result.result;
  let succeeded: boolean;
  let results: xdr.OperationResult[] = [];
  if (body.type === "txFeeBumpInnerSuccess" || body.type === "txFeeBumpInnerFailed") {
    if (hex(body.innerResultPair.transactionHash.value) !== innerHash) {
      throw new DeliveredReadError("The provider's result is not this transaction's.");
    }
    const inner = body.innerResultPair.result.result;
    succeeded = inner.type === "txSuccess";
    if (inner.type === "txSuccess") results = inner.results;
  } else {
    succeeded = body.type === "txSuccess";
    if (body.type === "txSuccess") results = body.results;
  }

  if (succeeded !== seen.successful) {
    throw new DeliveredReadError("The provider's status contradicts its result.");
  }
  if (succeeded && results.length !== tx.operations.length) {
    throw new DeliveredReadError("The provider's result does not match the operations.");
  }
  return { tx, succeeded, results };
}

function mergeBalance(result: xdr.OperationResult): bigint | null {
  if (result.type !== "opInner" || result.tr.type !== "accountMerge") return null;
  const merge = result.tr.accountMergeResult;
  return merge.type === "accountMergeSuccess" ? merge.sourceAccountBalance : null;
}

function paymentSucceeded(result: xdr.OperationResult): boolean {
  return (
    result.type === "opInner" &&
    result.tr.type === "payment" &&
    result.tr.paymentResult.type === "paymentSuccess"
  );
}

/**
 * The XLM the transaction credited to `destination`, or null when it credited none this counts.
 *
 * Counted: the balance each successful merge into the destination carried, as the merge's own
 * result reports it; and a successful native payment to the destination whose source is the
 * account a successful merge earlier in the same transaction went into (the relay forward), at
 * most one per merge. Nothing else counts: a path payment, a payment without such a merge, or
 * any asset other than XLM. A forward larger than its merge carried is not a forward of it, and
 * leaves the whole transaction uncounted.
 */
function deliveredBy(
  tx: Applied,
  results: readonly xdr.OperationResult[],
  destination: string
): bigint | null {
  const relayMerges: { into: string; balance: bigint; forwarded: boolean }[] = [];
  let total = 0n;
  let counted = false;

  for (const [i, op] of tx.operations.entries()) {
    const result = results[i]!;
    const body = op.body;
    if (body.type === "accountMerge") {
      const balance = mergeBalance(result);
      if (balance === null) continue;
      const into = accountOf(body.destination);
      if (into === destination) {
        total += balance;
        counted = true;
      } else {
        relayMerges.push({ into, balance, forwarded: false });
      }
    } else if (
      body.type === "payment" &&
      body.paymentOp.asset.type === "assetTypeNative" &&
      accountOf(body.paymentOp.destination) === destination &&
      paymentSucceeded(result)
    ) {
      const from = op.sourceAccount ? accountOf(op.sourceAccount) : tx.source;
      const merge = relayMerges.find((m) => m.into === from && !m.forwarded);
      if (!merge) continue;
      if (body.paymentOp.amount > merge.balance) return null;
      merge.forwarded = true;
      total += body.paymentOp.amount;
      counted = true;
    }
  }
  return counted ? total : null;
}

async function readOne(
  rpcServer: Pick<rpc.Server, "getTransaction">,
  horizon: HorizonTransactionReader,
  network: Network,
  destination: string,
  hash: string
): Promise<CloseDeliveredEntry> {
  let seen: Seen | null = null;
  let rpcSaidNotFound = false;
  try {
    const answer = await rpcServer.getTransaction(hash);
    if (answer.status === "NOT_FOUND") rpcSaidNotFound = true;
    else
      seen = {
        successful: answer.status === "SUCCESS",
        ledger: answer.ledger,
        envelope: answer.envelopeXdr,
        result: answer.resultXdr,
      };
  } catch {
    // RPC could not answer: Horizon may, and a second failure below is the caller's 503.
  }

  if (!seen) {
    const record = await horizon(hash);
    if (record === null) {
      // Only two providers both saying "not held" is not_found; one silent RPC is a failed read.
      if (!rpcSaidNotFound) throw new DeliveredReadError("No provider could be read.");
      return { hash, status: "unavailable", reason: "not_found" };
    }
    if (
      typeof record.successful !== "boolean" ||
      typeof record.ledger !== "number" ||
      typeof record.envelope_xdr !== "string" ||
      typeof record.result_xdr !== "string"
    ) {
      throw new DeliveredReadError("The provider's transaction record is incomplete.");
    }
    seen = {
      successful: record.successful,
      ledger: record.ledger,
      envelope: record.envelope_xdr,
      result: record.result_xdr,
    };
  }

  const { tx, succeeded, results } = bind(hash, network, seen);
  if (!succeeded) return { hash, status: "unavailable", reason: "failed", ledger: seen.ledger };
  const amount = deliveredBy(tx, results, destination);
  if (amount === null) {
    return { hash, status: "unavailable", reason: "no_delivery", ledger: seen.ledger };
  }
  return { hash, status: "delivered", ledger: seen.ledger, amountStroops: amount.toString() };
}

/**
 * The XLM each confirmed close transaction delivered to `destination`, read from the ledger's
 * result for it: RPC first, then Horizon when RPC does not hold it. `hashes` are lowercase,
 * distinct and already validated. Throws when a provider cannot be read or answers with another
 * transaction, so a caller never reports an amount, or its absence, from a read it cannot trust.
 */
export async function readDelivered(
  rpcServer: Pick<rpc.Server, "getTransaction">,
  horizon: HorizonTransactionReader,
  network: Network,
  destination: string,
  hashes: readonly string[]
): Promise<CloseDeliveredResponse> {
  const entries: CloseDeliveredEntry[] = [];
  for (let i = 0; i < hashes.length; i += DELIVERED_READ_CONCURRENCY) {
    const slice = hashes.slice(i, i + DELIVERED_READ_CONCURRENCY);
    entries.push(
      ...(await Promise.all(
        slice.map((hash) => readOne(rpcServer, horizon, network, destination, hash))
      ))
    );
  }

  const response: CloseDeliveredResponse = { destination, entries };
  if (entries.every((entry) => entry.status === "delivered")) {
    response.totalStroops = entries
      .reduce(
        (sum, entry) => sum + BigInt(entry.status === "delivered" ? entry.amountStroops : 0),
        0n
      )
      .toString();
  }
  return response;
}
