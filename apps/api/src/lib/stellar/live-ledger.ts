import { Keypair, SignerKey, xdr } from "@stellar/stellar-sdk";
import type { AccountState } from "@lumenwipe/types";
import type { getRpcServer } from "@/lib/stellar/rpc";
import { LiveReadError } from "@/lib/stellar/live-trustline";

type LedgerReader = Pick<ReturnType<typeof getRpcServer>, "getLedgerEntries">;

export interface LiveAccountEntry {
  sequence: string;
  numSubEntries: number;
  thresholds: { master: number; low: number; med: number; high: number };
  /** Every signer but the master key, whose weight is `thresholds.master`. */
  signers: Array<{ key: string; weight: number }>;
}

/** The ledger's own copy of the entries an `AccountState` describes, read in one batch. */
export interface LiveLedger {
  /** Null when the ledger holds no such account. */
  account: LiveAccountEntry | null;
}

const LABEL = "The account's ledger entries";

function accountKey(address: string): xdr.LedgerKey {
  return xdr.LedgerKey.account(
    new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(address).xdrAccountId() })
  );
}

function toLiveAccount(entry: xdr.AccountEntry): LiveAccountEntry {
  const [master, low, med, high] = entry.thresholds.value;
  return {
    sequence: entry.seqNum.toString(),
    numSubEntries: entry.numSubEntries,
    thresholds: { master: master!, low: low!, med: med!, high: high! },
    signers: entry.signers.map((s) => ({
      key: SignerKey.encodeSignerKey(s.key),
      weight: s.weight,
    })),
  };
}

/**
 * Reads the account entry `state` was enumerated from, over RPC. Any failed or malformed read
 * throws `LiveReadError`: an unconfirmed entry is never taken as unchanged.
 */
export async function readLiveLedger(
  server: LedgerReader,
  state: Pick<AccountState, "address">
): Promise<LiveLedger> {
  let entries: Awaited<ReturnType<LedgerReader["getLedgerEntries"]>>["entries"];
  try {
    entries = (await server.getLedgerEntries(accountKey(state.address))).entries;
  } catch {
    throw new LiveReadError(LABEL);
  }
  if (!Array.isArray(entries)) throw new LiveReadError(LABEL);
  const live: LiveLedger = { account: null };
  for (const entry of entries) {
    if (entry.val.type !== "account") throw new LiveReadError(LABEL);
    live.account = toLiveAccount(entry.val.account);
  }
  return live;
}
