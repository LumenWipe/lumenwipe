import { Asset, Keypair, xdr } from "@stellar/stellar-sdk";
import type { getRpcServer } from "@/lib/stellar/rpc";

const AUTHORIZED_FLAG = 1;

export interface LiveTrustline {
  balance: bigint;
  limit: bigint;
  buyingLiabilities: bigint;
  /** Fully authorized: only this state can receive a payment. A line authorized solely to
   *  maintain liabilities keeps its offers but rejects incoming payments. */
  authorized: boolean;
}

export class LiveReadError extends Error {
  constructor(what: string) {
    super(`${what} could not be read from the network. Retry in a moment.`);
    this.name = "LiveReadError";
  }
}

type LedgerReader = Pick<ReturnType<typeof getRpcServer>, "getLedgerEntries">;

/**
 * The trustline's exact ledger entry, or null when the ledger confirms it does not exist.
 *
 * Not `server.getAssetBalance`: the SDK wraps its lookup in a catch that reports every failure,
 * network errors included, as "trustline not found", so a read that failed cannot be told from
 * a line that is gone. An empty `entries` is the only answer that means absent here.
 */
export async function readLiveTrustline(
  server: LedgerReader,
  account: string,
  asset: Asset,
  label: string
): Promise<LiveTrustline | null> {
  const key = xdr.LedgerKey.trustline(
    new xdr.LedgerKeyTrustLine({
      accountId: Keypair.fromPublicKey(account).xdrAccountId(),
      asset: asset.toTrustLineXDRObject(),
    })
  );
  let entries: Awaited<ReturnType<LedgerReader["getLedgerEntries"]>>["entries"];
  try {
    entries = (await server.getLedgerEntries(key)).entries;
  } catch {
    throw new LiveReadError(label);
  }
  if (!Array.isArray(entries)) throw new LiveReadError(label);
  const entry = entries[0];
  if (!entry) return null;
  const line = entry.val.trustLine();
  const v1 = line.ext().switch() === 1 ? line.ext().v1() : null;
  return {
    balance: BigInt(line.balance().toString()),
    limit: BigInt(line.limit().toString()),
    buyingLiabilities: v1 ? BigInt(v1.liabilities().buying().toString()) : 0n,
    authorized: (line.flags() & AUTHORIZED_FLAG) !== 0,
  };
}
