import type { Network } from "@/config/networks";
import { BASE_RESERVE_XLM } from "@/config/constants";
import { fetchOwnerLiveStatesBounded } from "@/lib/stellar/sponsorship";
import { RESERVES_PER_ENTRY, type OwnerLiveState } from "@/lib/stellar/sponsorship-reconcile";
import type { SponsoredEntry } from "@lumenwipe/types";

export interface SponsorshipAffordability {
  /** Entries confirmed still live-sponsored by the caller and whose owner can absorb the
   *  shifted reserve. Safe to build a REVOKE_SPONSORSHIP op for. */
  revocable: SponsoredEntry[];
  /** owner address -> the entries this owner cannot yet absorb, plus how much more XLM
   *  the owner needs. Never includes claimable_balance entries (excluded by callers -
   *  see the CAP-33 note in tx-builder/index.ts). */
  unaffordableOwners: Map<string, { entries: SponsoredEntry[]; shortfallXlm: string }>;
  /** Owners whose live state could not be read, so neither the sponsorship nor the reserve could
   *  be checked. Never dropped: the account may still sponsor their entries, which would fail
   *  the merge with ACCOUNT_MERGE_IS_SPONSOR. */
  unverifiedOwners: string[];
}

type OwnedEntry = Exclude<SponsoredEntry, { kind: "claimable_balance" }>;

function currentSponsorFor(live: OwnerLiveState, entry: OwnedEntry): string | null {
  switch (entry.kind) {
    case "account":
      return live.accountSponsor;
    case "trustline":
      return live.trustlineSponsors[entry.asset] ?? null;
    case "offer":
      return live.offerSponsors[entry.offerId] ?? null;
    case "data_entry":
      return live.dataSponsors[entry.name] ?? null;
    case "signer":
      return live.signerSponsors[entry.signerKey] ?? null;
  }
}

/**
 * Re-reads each distinct owner's live sponsorship + reserve state and decides, per owner,
 * whether revoking every entry this account still sponsors for them leaves the owner at or
 * above its minimum balance. Doubles as the "live re-read before build" check: an entry no
 * longer live-sponsored by `address` (resolved by someone else, or the owner vanished) is
 * silently dropped from both `revocable` and `unaffordableOwners` - it needs no operation. An
 * owner whose read fails is reported in `unverifiedOwners` instead, never dropped.
 *
 * Decision granularity is per owner, not per entry: an owner's entries are all-revocable or
 * all-blocked together, based on the owner's TOTAL shifted reserve, so a build never leaves
 * one owner half-resolved. Excludes claimable_balance entries entirely - callers must filter
 * those out before calling (see the CAP-33 note in tx-builder/index.ts for why).
 */
export async function assessSponsorshipAffordability(
  address: string,
  entries: SponsoredEntry[],
  network: Network
): Promise<SponsorshipAffordability> {
  const byOwner = new Map<string, OwnedEntry[]>();
  for (const entry of entries) {
    if (entry.kind === "claimable_balance") continue;
    const list = byOwner.get(entry.owner) ?? [];
    list.push(entry);
    byOwner.set(entry.owner, list);
  }

  const revocable: SponsoredEntry[] = [];
  const unaffordableOwners: SponsorshipAffordability["unaffordableOwners"] = new Map();
  const unverifiedOwners: string[] = [];

  const owners = Array.from(byOwner.keys());
  const liveStateByOwner = await fetchOwnerLiveStatesBounded(owners, network);

  owners.forEach((owner) => {
    const ownerEntries = byOwner.get(owner)!;
    const live = liveStateByOwner.get(owner)!;
    // Unknown, not "nothing to revoke": the caller blocks on it rather than guess.
    if (live.fetchFailed || live.reserve === null) {
      unverifiedOwners.push(owner);
      return;
    }

    const stillSponsored = ownerEntries.filter((e) => currentSponsorFor(live, e) === address);
    if (stillSponsored.length === 0) return; // fully resolved already

    const totalMult = stillSponsored.reduce((sum, e) => sum + RESERVES_PER_ENTRY[e.kind], 0);
    const currentMinBalance =
      (2 + live.reserve.numSubEntries + live.reserve.numSponsoring - live.reserve.numSponsored) *
      BASE_RESERVE_XLM;
    const availableBalance =
      Number(live.reserve.balanceLumens) -
      currentMinBalance -
      Number(live.reserve.sellingLiabilities);
    const neededXlm = totalMult * BASE_RESERVE_XLM;

    if (availableBalance >= neededXlm) {
      revocable.push(...stillSponsored);
    } else {
      unaffordableOwners.set(owner, {
        entries: stillSponsored,
        shortfallXlm: (neededXlm - availableBalance).toFixed(7),
      });
    }
  });

  return { revocable, unaffordableOwners, unverifiedOwners };
}
