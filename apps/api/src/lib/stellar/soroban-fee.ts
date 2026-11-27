import { Transaction, xdr, type rpc } from "@stellar/stellar-sdk";
import {
  BASE_FEE_STROOPS,
  MAX_SOROBAN_INCLUSION_FEE_STROOPS,
  SOROBAN_FEE_STATS_TTL_MS,
} from "@/config/constants";

export type FeeStatsRpc = Pick<rpc.Server, "getFeeStats">;

/** The network is pricing Soroban inclusion above what LumenWipe bids for one transaction. */
export class SorobanFeeSurgeError extends Error {
  constructor() {
    super(
      "Soroban network fees are surging above what LumenWipe pays for one transaction " +
        `(${MAX_SOROBAN_INCLUSION_FEE_STROOPS} stroops), so nothing was built. Retry in a few minutes.`
    );
    this.name = "SorobanFeeSurgeError";
  }
}

interface CachedBid {
  at: number;
  bid: Promise<bigint | null>;
}

const cache = new WeakMap<FeeStatsRpc, CachedBid>();

/**
 * Twice the 90th percentile: a write-saturated lane fills with bids tied at the floor, and a lane
 * charges every included transaction the lowest included bid, so the headroom wins inclusion at
 * almost no cost. Null when the stats are unreadable.
 */
async function readBid(server: FeeStatsRpc): Promise<bigint | null> {
  try {
    const p90 = (await server.getFeeStats()).sorobanInclusionFee.p90;
    if (typeof p90 !== "string" || !/^\d{1,18}$/.test(p90)) return null;
    const bid = 2n * BigInt(p90);
    return bid > BigInt(BASE_FEE_STROOPS) ? bid : BigInt(BASE_FEE_STROOPS);
  } catch {
    return null;
  }
}

/**
 * The inclusion fee for one Soroban transaction, from the network's recent fee stats. When the
 * stats cannot be read it bids the cap: the lane charges its lowest included bid, so the cap costs
 * more than a priced bid only when the network is already charging close to it.
 */
export async function sorobanInclusionFee(
  server: FeeStatsRpc,
  now: () => number = Date.now
): Promise<bigint> {
  let entry = cache.get(server);
  if (!entry || now() - entry.at >= SOROBAN_FEE_STATS_TTL_MS) {
    entry = { at: now(), bid: readBid(server) };
    cache.set(server, entry);
  }
  const bid = await entry.bid;
  if (bid === null) {
    if (cache.get(server) === entry) cache.delete(server);
    return BigInt(MAX_SOROBAN_INCLUSION_FEE_STROOPS);
  }
  if (bid > BigInt(MAX_SOROBAN_INCLUSION_FEE_STROOPS)) throw new SorobanFeeSurgeError();
  return bid;
}

const MAX_UINT32 = 0xffff_ffffn;

/** The same transaction bidding `inclusionFee` on top of the resource fee it declares. */
export function withInclusionFee(tx: Transaction, inclusionFee: bigint): Transaction {
  const envelope = tx.toEnvelope();
  if (envelope.type !== "envelopeTypeTx") throw new Error("not a plain transaction");
  const inner = envelope.v1.tx;
  if (inner.ext.type !== "sorobanData") throw new Error("not a Soroban transaction");
  const fee = inner.ext.sorobanData.resourceFee + inclusionFee;
  if (fee > MAX_UINT32) throw new Error("the fee does not fit a transaction");
  const rebuilt = xdr.TransactionEnvelope.envelopeTypeTx(
    new xdr.TransactionV1Envelope({
      tx: new xdr.Transaction({
        sourceAccount: inner.sourceAccount,
        fee: Number(fee),
        seqNum: inner.seqNum,
        cond: inner.cond,
        memo: inner.memo,
        operations: inner.operations,
        ext: inner.ext,
      }),
      signatures: envelope.v1.signatures,
    })
  );
  return new Transaction(rebuilt, tx.networkPassphrase);
}
