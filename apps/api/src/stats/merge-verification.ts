import { FeeBumpTransaction, rpc, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { getRpcServer } from "@/lib/stellar/rpc";
import { NETWORK_PASSPHRASES, type Network } from "@/config/networks";

export interface MergeSummary {
  accountsClosed: number;
  xlmStroops: string;
}

export interface VerifiedMerge extends MergeSummary {
  txHash: string;
  /** Hash of the transaction as built, which is the inner transaction of a fee bump. */
  builtHash: string;
  closedAt: Date;
}

type GetTransaction = (txHash: string) => Promise<rpc.Api.GetTransactionResponse>;

function envelopeOperations(envelope: xdr.TransactionEnvelope): xdr.Operation[] {
  switch (envelope.type) {
    case "envelopeTypeTx":
      return envelope.v1.tx.operations;
    case "envelopeTypeTxV0":
      return envelope.v0.tx.operations;
    case "envelopeTypeTxFeeBump":
      return envelope.feeBump.tx.innerTx.v1.tx.operations;
    default:
      return [];
  }
}

function operationResults(result: xdr.TransactionResult): xdr.OperationResult[] {
  const body = result.result;
  switch (body.type) {
    case "txSuccess":
      return body.results;
    case "txFeeBumpInnerSuccess": {
      const inner = body.innerResultPair.result.result;
      return inner.type === "txSuccess" ? inner.results : [];
    }
    default:
      return [];
  }
}

export function hasAccountMerge(envelope: xdr.TransactionEnvelope): boolean {
  return envelopeOperations(envelope).some((op) => op.body.type === "accountMerge");
}

/** Decodes a client-signed envelope; false for anything that does not decode. */
export function signedXdrHasAccountMerge(signedXdr: string): boolean {
  try {
    return hasAccountMerge(xdr.TransactionEnvelope.fromXdr(signedXdr, "base64"));
  } catch {
    return false;
  }
}

/**
 * The hash a transaction had when it was built. Signatures, a mediator co-signature and a fee
 * bump wrapper all leave it unchanged.
 */
export function builtTransactionHash(envelope: xdr.TransactionEnvelope, network: Network): string {
  const tx = TransactionBuilder.fromXDR(envelope, NETWORK_PASSPHRASES[network]);
  const built = tx instanceof FeeBumpTransaction ? tx.innerTransaction : tx;
  return Buffer.from(built.hash()).toString("hex");
}

function envelopeHash(envelope: xdr.TransactionEnvelope, network: Network): string {
  const tx = TransactionBuilder.fromXDR(envelope, NETWORK_PASSPHRASES[network]);
  return Buffer.from(tx.hash()).toString("hex");
}

/** Hashes of the built transactions that carry an account merge; anything undecodable is skipped. */
export function builtCloseHashes(transactions: { xdr: string }[], network: Network): string[] {
  const hashes: string[] = [];
  for (const { xdr: encoded } of transactions) {
    try {
      const envelope = xdr.TransactionEnvelope.fromXDR(encoded, "base64");
      if (hasAccountMerge(envelope)) hashes.push(builtTransactionHash(envelope, network));
    } catch {
      continue;
    }
  }
  return hashes;
}

/**
 * Counts the successful account merges a confirmed transaction performed and the XLM they
 * moved, read from the ledger's own result rather than anything the caller claimed. Null when
 * the envelope carries no merge or no merge succeeded.
 */
export function summarizeMerges(
  envelope: xdr.TransactionEnvelope,
  result: xdr.TransactionResult
): MergeSummary | null {
  if (!hasAccountMerge(envelope)) return null;

  let accountsClosed = 0;
  let stroops = 0n;
  for (const op of operationResults(result)) {
    if (op.type !== "opInner") continue;
    const tr = op.tr;
    if (tr.type !== "accountMerge") continue;
    const merge = tr.accountMergeResult;
    if (merge.type !== "accountMergeSuccess") continue;
    accountsClosed += 1;
    stroops += merge.sourceAccountBalance;
  }
  return accountsClosed > 0 ? { accountsClosed, xlmStroops: stroops.toString() } : null;
}

/**
 * Independently confirms on-chain that `txHash` is a successful close before anything is
 * counted. Null for a missing, failed, or non-merge transaction, and for an RPC or decoding
 * error: an unverifiable close is not counted rather than counted on trust.
 */
export async function verifyMerge(
  txHash: string,
  network: Network,
  getTransaction: GetTransaction = (hash) => getRpcServer(network).getTransaction(hash)
): Promise<VerifiedMerge | null> {
  try {
    const response = await getTransaction(txHash);
    if (response.status !== rpc.Api.GetTransactionStatus.SUCCESS) return null;
    if (envelopeHash(response.envelopeXdr, network) !== txHash.toLowerCase()) return null;

    const summary = summarizeMerges(response.envelopeXdr, response.resultXdr);
    if (!summary) return null;
    return {
      txHash,
      builtHash: builtTransactionHash(response.envelopeXdr, network),
      ...summary,
      closedAt: new Date(response.createdAt * 1000),
    };
  } catch {
    return null;
  }
}
