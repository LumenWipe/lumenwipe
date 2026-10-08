import { rpc, xdr } from "@stellar/stellar-sdk";
import { getRpcServer } from "@/lib/stellar/rpc";
import type { Network } from "@/config/networks";

export interface MergeSummary {
  accountsClosed: number;
  xlmStroops: string;
}

export interface VerifiedMerge extends MergeSummary {
  txHash: string;
  closedAt: Date;
}

type GetTransaction = (txHash: string) => Promise<rpc.Api.GetTransactionResponse>;

function envelopeOperations(envelope: xdr.TransactionEnvelope): xdr.Operation[] {
  switch (envelope.switch().name) {
    case "envelopeTypeTx":
      return envelope.v1().tx().operations();
    case "envelopeTypeTxV0":
      return envelope.v0().tx().operations();
    case "envelopeTypeTxFeeBump":
      return envelope.feeBump().tx().innerTx().v1().tx().operations();
    default:
      return [];
  }
}

function operationResults(result: xdr.TransactionResult): xdr.OperationResult[] {
  const body = result.result();
  switch (body.switch().name) {
    case "txSuccess":
      return body.results();
    case "txFeeBumpInnerSuccess":
      return body.innerResultPair().result().result().results();
    default:
      return [];
  }
}

export function hasAccountMerge(envelope: xdr.TransactionEnvelope): boolean {
  return envelopeOperations(envelope).some((op) => op.body().switch().name === "accountMerge");
}

/** Decodes a client-signed envelope; false for anything that does not decode. */
export function signedXdrHasAccountMerge(signedXdr: string): boolean {
  try {
    return hasAccountMerge(xdr.TransactionEnvelope.fromXDR(signedXdr, "base64"));
  } catch {
    return false;
  }
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
    if (op.switch().name !== "opInner") continue;
    const tr = op.tr();
    if (tr.switch().name !== "accountMerge") continue;
    const merge = tr.accountMergeResult();
    if (merge.switch().name !== "accountMergeSuccess") continue;
    accountsClosed += 1;
    stroops += BigInt(merge.sourceAccountBalance().toString());
  }
  return accountsClosed > 0 ? { accountsClosed, xlmStroops: stroops.toString() } : null;
}

/**
 * Independently confirms on-chain that `txHash` is a successful close before anything is
 * counted. Null for a missing, failed, or non-merge transaction, and for an RPC error: an
 * unverifiable close is not counted rather than counted on trust.
 */
export async function verifyMerge(
  txHash: string,
  network: Network,
  getTransaction: GetTransaction = (hash) => getRpcServer(network).getTransaction(hash)
): Promise<VerifiedMerge | null> {
  let response: rpc.Api.GetTransactionResponse;
  try {
    response = await getTransaction(txHash);
  } catch {
    return null;
  }
  if (response.status !== rpc.Api.GetTransactionStatus.SUCCESS) return null;

  const summary = summarizeMerges(response.envelopeXdr, response.resultXdr);
  if (!summary) return null;
  return { txHash, ...summary, closedAt: new Date(response.createdAt * 1000) };
}
