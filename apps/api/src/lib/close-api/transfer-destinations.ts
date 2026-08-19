import type { Network, TransferDestinations, Trustline } from "@lumenwipe/types";
import { lookupExchange } from "@/lib/exchange-registry";
import { xlmToStroops } from "@/lib/utils/amounts";

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

/** Matches the cap sponsorship.ts uses for the same reason: caller-supplied addresses must not
 *  fan out without bound. */
const DESTINATION_READ_CONCURRENCY = 10;

/** One destination that cannot receive its asset, and why, in words the caller can act on. */
export interface TransferDestinationProblem {
  asset: string;
  destination: string;
  code:
    | "destination_missing"
    | "destination_lacks_trustline"
    | "destination_not_authorized"
    | "destination_limit_too_low"
    | "destination_is_source"
    | "destination_is_exchange";
  message: string;
}

/** The destination's trustlines, or null when the account does not exist. Injected so the
 *  validation is testable without network. */
export type AccountReader = (
  address: string,
  network: Network
) => Promise<{ trustlines: Trustline[] } | null>;

function findTrustline(trustlines: Trustline[], asset: string): Trustline | undefined {
  return trustlines.find((tl) => tl.asset === asset);
}

/**
 * Headroom under the destination's trustline limit, in whole stroops.
 *
 * BigInt, not Number. Stellar amounts are int64 stroops - up to 922337203685.4775807 - and a
 * double carries about 15 significant digits, so `Number()` on a 7-decimal string silently
 * rounds exactly where the answer matters. It goes wrong in both directions: a nearly-full
 * line reads as having room (the ledger then rejects the whole atomic close), and an exact fit
 * like 0.2 + 0.1 <= 0.3 reads as overflowing (a legitimate transfer refused, with a message
 * quoting numbers that visibly add up). `verify()` compares in whole stroops for the same
 * reason.
 *
 * An absent limit means unknown, and unknown does not block: the field is optional on
 * `Trustline`, and refusing every transfer because a provider stopped reporting it would be a
 * silent, total outage of the feature rather than a real constraint. The ledger still enforces
 * the real limit.
 */
function hasRoomFor(destinationTrustline: Trustline, amount: string): boolean {
  if (destinationTrustline.limit === undefined) return true;
  try {
    const limit = BigInt(xlmToStroops(destinationTrustline.limit));
    const held = BigInt(xlmToStroops(destinationTrustline.balance));
    const incoming = BigInt(xlmToStroops(amount));
    return held + incoming <= limit;
  } catch {
    // An unparseable figure is not evidence of no room; leave it to the ledger.
    return true;
  }
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

  // Only addresses whose ledger state actually decides the outcome are read. The source
  // account, a registry exchange, and an asset's own issuer are all resolved from the address
  // alone, so reading them would be a network call whose answer changes nothing.
  const needsRead = [
    ...new Set(
      entries
        .filter(([asset, address]) => {
          if (address === sourceAddress) return false;
          if (lookupExchange(address) !== null) return false;
          return asset.split(":")[1] !== address;
        })
        .map(([, address]) => address)
    ),
  ];

  // Bounded, not a bare Promise.all. The addresses come from the request body, one per asset,
  // so an unbounded fan-out lets a single call burn the shared Horizon budget - the same reason
  // sponsorship.ts caps its owner reads.
  const accounts = new Map<string, { trustlines: Trustline[] } | null>();
  for (let i = 0; i < needsRead.length; i += DESTINATION_READ_CONCURRENCY) {
    const slice = needsRead.slice(i, i + DESTINATION_READ_CONCURRENCY);
    const read = await Promise.all(slice.map((address) => readAccount(address, network)));
    slice.forEach((address, j) => accounts.set(address, read[j] ?? null));
  }

  const problems: TransferDestinationProblem[] = [];
  for (const [asset, destination] of entries) {
    const code = asset.split(":")[0] ?? asset;
    const issuer = asset.split(":")[1];

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

    // The same unrecoverable outcome the merge destination is guarded against, one asset over.
    // Exchanges credit deposits from payments carrying their memo, and the close carries a
    // single transaction-level memo for the merge - there is nowhere to put a per-asset deposit
    // memo, so a token payment to a deposit address is credited to nobody and cannot be
    // reversed. Absence from the registry proves nothing, but presence in it is proof enough to
    // refuse: this is the one case we can recognize with certainty.
    const exchange = lookupExchange(destination);
    if (exchange !== null) {
      problems.push({
        asset,
        destination,
        code: "destination_is_exchange",
        message: `The account chosen for ${code} is a deposit address for ${exchange.name}. A token payment cannot carry the deposit memo an exchange needs to credit it, so the ${code} would be lost. Send ${code} to a wallet you control and deposit it from there, or convert it to XLM.`,
      });
      continue;
    }

    // Paying an asset to its own issuer is how it is burned - the ledger accepts it, and the
    // issuer holds no trustline to its own asset, so the trustline check below would refuse a
    // payment that works. Allowed here, with `return_to_issuer` remaining the direct way to say
    // it.
    if (issuer !== undefined && destination === issuer) continue;

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

    const trustline = findTrustline(account.trustlines, asset);
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

    // A held trustline is not the same as a usable one. For an asset whose issuer requires
    // authorization, an unauthorized line rejects the payment (PAYMENT_NOT_AUTHORIZED) and
    // takes the whole atomic close down with it.
    if (!trustline.authorized) {
      problems.push({
        asset,
        destination,
        code: "destination_not_authorized",
        message: `The account chosen for ${code} holds a ${code} trustline that its issuer has not authorized, so it cannot receive it. Ask the issuer to authorize that account, choose a different account, or convert ${code} to XLM.`,
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
