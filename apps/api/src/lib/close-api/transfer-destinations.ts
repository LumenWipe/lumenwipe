import type { AccountState, Network, TransferDestinations, Trustline } from "@lumenwipe/types";

/**
 * Validates the destinations a `transfer` disposition names, before anything is built.
 *
 * A transfer payment fails on-chain for reasons the caller cannot see from the plan: the account
 * may not exist, may not trust the asset, or may not have room under its trustline limit. Any of
 * those aborts the whole fused close, and because the close is one atomic transaction the account
 * is left exactly as it was - open, with the user believing it was wound down. Catching it here
 * turns a confusing failed submission into a blocker naming what to do about it.
 *
 * Deliberately not "fix it for them". Every automatic remedy available is worse than stopping:
 * converting or burning destroys the balance the user asked to keep, and a claimable balance -
 * the obvious way to "send it anyway" - makes the source account the sponsor of a new ledger
 * entry, so `numSponsoring` becomes 1 and `ACCOUNT_MERGE` then fails with
 * ACCOUNT_MERGE_IS_SPONSOR. The helpful-looking fallback would make the close impossible.
 */

/** One destination that cannot receive its asset, and why, in words the caller can act on. */
export interface TransferDestinationProblem {
  asset: string;
  destination: string;
  code:
    | "destination_missing"
    | "destination_lacks_trustline"
    | "destination_limit_too_low"
    | "destination_is_source";
  message: string;
}

/** Reads the destination account. Injected so the validation is testable without network. */
export type AccountReader = (address: string, network: Network) => Promise<AccountState | null>;

function findTrustline(account: AccountState, asset: string): Trustline | undefined {
  return account.trustlines.find((tl) => tl.asset === asset);
}

/**
 * Headroom under the destination's trustline limit.
 *
 * `limit` is optional on `Trustline` because the RPC reader never exposed it; the Horizon reader
 * always does, and it is the only reader the API uses since #110. Treated as unknown rather than
 * as zero when absent: defaulting a missing limit to "0" would block every transfer against a
 * provider that stopped reporting it, which is a silent, total outage of the feature rather than
 * a real constraint. An unknown limit lets the transfer through and leaves the ledger to reject
 * it, which is the same position every other operation here is in.
 */
function hasRoomFor(destinationTrustline: Trustline, amount: string): boolean {
  if (destinationTrustline.limit === undefined) return true;
  const limit = Number(destinationTrustline.limit);
  const held = Number(destinationTrustline.balance);
  const incoming = Number(amount);
  if (!Number.isFinite(limit) || !Number.isFinite(held) || !Number.isFinite(incoming)) return true;
  return held + incoming <= limit;
}

/**
 * Checks every transfer destination against live ledger state.
 *
 * Returns every problem rather than the first, so a caller transferring three assets is told
 * about all three at once instead of discovering them one rebuild at a time.
 */
export async function validateTransferDestinations(
  destinations: TransferDestinations,
  sourceTrustlines: Trustline[],
  sourceAddress: string,
  network: Network,
  readAccount: AccountReader
): Promise<TransferDestinationProblem[]> {
  const entries = Object.entries(destinations);
  if (entries.length === 0) return [];

  const balanceFor = new Map(sourceTrustlines.map((tl) => [tl.asset, tl.balance]));

  // One read per distinct address, not per asset: transferring five assets to the same account
  // is one lookup.
  const unique = [...new Set(entries.map(([, address]) => address))];
  const accounts = new Map<string, AccountState | null>(
    await Promise.all(
      unique.map(
        async (address) =>
          [address, await readAccount(address, network)] as [string, AccountState | null]
      )
    )
  );

  const problems: TransferDestinationProblem[] = [];
  for (const [asset, destination] of entries) {
    const code = asset.split(":")[0] ?? asset;

    // Paying an asset to the account being merged away would send it into a ledger entry that
    // ceases to exist moments later in the same transaction.
    if (destination === sourceAddress) {
      problems.push({
        asset,
        destination,
        code: "destination_is_source",
        message: `${code} cannot be transferred to the account being closed. Choose a different account, convert it to XLM, or return it to its issuer.`,
      });
      continue;
    }

    const account = accounts.get(destination) ?? null;
    if (!account) {
      problems.push({
        asset,
        destination,
        code: "destination_missing",
        message: `The account chosen for ${code} does not exist on ${network}. Fund it first, or choose a different account.`,
      });
      continue;
    }

    const trustline = findTrustline(account, asset);
    if (!trustline) {
      // LumenWipe cannot add it: creating a trustline needs the destination account's own
      // signature, which the tool never has.
      problems.push({
        asset,
        destination,
        code: "destination_lacks_trustline",
        message: `The account chosen for ${code} does not hold a ${code} trustline, so it cannot receive it. Add the trustline from that account and retry, or convert ${code} to XLM or return it to its issuer.`,
      });
      continue;
    }

    const amount = balanceFor.get(asset);
    if (amount !== undefined && !hasRoomFor(trustline, amount)) {
      problems.push({
        asset,
        destination,
        code: "destination_limit_too_low",
        message: `The account chosen for ${code} cannot hold ${amount} more ${code}: its trustline limit is ${trustline.limit}, and it already holds ${trustline.balance}. Raise the limit from that account and retry, or choose a different account.`,
      });
    }
  }
  return problems;
}
