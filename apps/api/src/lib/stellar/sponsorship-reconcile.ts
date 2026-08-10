import type { SponsoredEntry } from "@lumenwipe/types";

export interface SponsorshipCandidate {
  kind: SponsoredEntry["kind"];
  owner: string;
  // Asset string for "trustline", data name for "data_entry", signer key for
  // "signer". Unused for "offer" (owner's full current offer list is swept
  // instead - see the module doc comment) and "account" (owner is the key).
  key: string;
}

export interface OwnerLiveState {
  // Top-level account "sponsor" field - relevant to "account"-kind candidates.
  accountSponsor: string | null;
  // Keyed by asset string ("native" or "CODE:ISSUER").
  trustlineSponsors: Record<string, string | null>;
  // Keyed by signer public key.
  signerSponsors: Record<string, string | null>;
  // Keyed by offer ID. Populated from the owner's full current offer list,
  // not from historical candidate keys (manage_offer operations don't expose
  // the assigned ID for a fresh offer - see sponsorship.ts).
  offerSponsors: Record<string, string | null>;
  // Keyed by data entry name.
  dataSponsors: Record<string, string | null>;
  // True if any live fetch for this owner failed - the candidate can't be
  // confirmed or ruled out, so it must never be silently dropped.
  fetchFailed: boolean;
  /** This owner's live reserve numbers, straight off the same Horizon-compatible account
   *  resource already fetched for the sponsor-field checks above - null when that fetch
   *  failed (fetchFailed is the source of truth for "don't trust anything else on this
   *  object"), never a placeholder zero. */
  reserve: {
    balanceLumens: string;
    numSubEntries: number;
    numSponsoring: number;
    numSponsored: number;
    // Horizon's native-balance `selling_liabilities` - XLM tied up in open sell offers
    // that stellar-core's own getAvailableBalance() (and thus the LOW_RESERVE gate on
    // RevokeSponsorship) subtracts before comparing against the minimum balance.
    sellingLiabilities: string;
  } | null;
}

// Base reserves each enumerated entry kind costs its sponsor. numSponsoring counts
// sponsored *reserves*, not sponsored *entries*, so the cross-check below can only
// compare like with like after this conversion.
//
// Known minor imprecision: a sponsored liquidity-pool-share trustline actually costs 2
// reserves, but SponsoredEntry has no way to distinguish one from a regular trustline,
// so every trustline is counted as 1. That can only make the expected total too low,
// which errs toward flagging incomplete - never toward a silent "sponsors nothing".
export const RESERVES_PER_ENTRY: Record<
  Exclude<SponsoredEntry["kind"], "claimable_balance">,
  number
> = {
  account: 2, // a fully-sponsored account creation costs 2 base reserves
  trustline: 1,
  offer: 1,
  data_entry: 1,
  signer: 1,
};

// Phase 2 always re-derives truth from current chain state, so a Phase 1 gap can only
// produce a missed candidate (caught by the numSponsoring cross-check below), never a
// wrong inclusion. This is why this function does not need to model the sponsorship
// bracket/transfer state machine at all.
export function reconcileSponsoredEntries(
  address: string,
  candidates: SponsorshipCandidate[],
  liveStateByOwner: Map<string, OwnerLiveState>,
  claimableBalanceEntries: SponsoredEntry[],
  discoveryIncomplete: boolean,
  claimableBalanceIncomplete: boolean,
  numSponsoring: number,
  // balanceId -> number of claimants, from the same Horizon page the entries came from.
  // A claimable balance costs its sponsor one base reserve *per claimant*, so its
  // reserve cost cannot be derived from SponsoredEntry alone. A missing entry here
  // falls back to 1 (the minimum), which again can only over-flag, never under-flag.
  claimantCountsByBalanceId: ReadonlyMap<string, number> = new Map()
): { sponsoredEntries: SponsoredEntry[]; sponsorshipEnumerationIncomplete: boolean } {
  const seen = new Set<string>();
  const sponsoredEntries: SponsoredEntry[] = [...claimableBalanceEntries];
  for (const e of claimableBalanceEntries) {
    if (e.kind === "claimable_balance") seen.add(`claimable_balance:${e.balanceId}`);
  }

  let anyLiveFetchFailed = false;

  for (const candidate of candidates) {
    const live = liveStateByOwner.get(candidate.owner);
    if (!live) continue; // no live data fetched for this owner - nothing to confirm
    if (live.fetchFailed) {
      anyLiveFetchFailed = true;
      continue;
    }

    // Offer and claimable_balance entries are never matched here - offers are fully
    // covered by the unconditional per-owner sweep below (every fetched owner's full
    // current offer list, not just owners a candidate happened to name), and claimable
    // balances are handled separately above.
    if (candidate.kind === "offer") continue;
    if (candidate.kind === "claimable_balance") continue; // handled above

    const currentSponsor =
      candidate.kind === "account"
        ? live.accountSponsor
        : candidate.kind === "trustline"
          ? (live.trustlineSponsors[candidate.key] ?? null)
          : candidate.kind === "signer"
            ? (live.signerSponsors[candidate.key] ?? null)
            : (live.dataSponsors[candidate.key] ?? null);

    if (currentSponsor !== address) continue;

    const dedupeKey = `${candidate.kind}:${candidate.owner}:${candidate.key}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    if (candidate.kind === "account") {
      sponsoredEntries.push({ kind: "account", owner: candidate.owner });
    } else if (candidate.kind === "trustline") {
      sponsoredEntries.push({ kind: "trustline", owner: candidate.owner, asset: candidate.key });
    } else if (candidate.kind === "signer") {
      sponsoredEntries.push({ kind: "signer", owner: candidate.owner, signerKey: candidate.key });
    } else {
      sponsoredEntries.push({ kind: "data_entry", owner: candidate.owner, name: candidate.key });
    }
  }

  // Trustline/signer/offer/data-entry candidates only fire when the specific historical
  // operation that created or removed the sponsorship happened to carry an explicit
  // `sponsor` field (see sponsorship.ts's discoverSponsorshipCandidates). A wrapped
  // change_trust/set_options/manage_data/manage_offer inside an open sponsorship bracket
  // might not carry that field, in which case the exact-key candidate above is never
  // produced - even though the owner's live state (already fetched, because *some*
  // candidate for that owner triggered the fetch) contains the answer. Sweep every
  // already-fetched owner's full current state for all four kinds, not just the keys
  // candidates happened to name, so a missing exact-key candidate can't cause a silent
  // omission. ("account" has no analogous sweep: begin_sponsoring_future_reserves always
  // carries sponsored_id and is always sourced directly by the sponsor - never wrapped
  // inside someone else's bracket - so its candidate can't have this gap.)
  for (const [owner, live] of liveStateByOwner) {
    if (live.fetchFailed) continue; // already counted via the candidate loop above

    for (const [asset, sponsor] of Object.entries(live.trustlineSponsors)) {
      if (sponsor !== address) continue;
      const dedupeKey = `trustline:${owner}:${asset}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      sponsoredEntries.push({ kind: "trustline", owner, asset });
    }

    for (const [signerKey, sponsor] of Object.entries(live.signerSponsors)) {
      if (sponsor !== address) continue;
      const dedupeKey = `signer:${owner}:${signerKey}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      sponsoredEntries.push({ kind: "signer", owner, signerKey });
    }

    for (const [offerId, sponsor] of Object.entries(live.offerSponsors)) {
      if (sponsor !== address) continue;
      const dedupeKey = `offer:${owner}:${offerId}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      sponsoredEntries.push({ kind: "offer", owner, offerId });
    }

    for (const [name, sponsor] of Object.entries(live.dataSponsors)) {
      if (sponsor !== address) continue;
      const dedupeKey = `data_entry:${owner}:${name}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      sponsoredEntries.push({ kind: "data_entry", owner, name });
    }
  }

  // Convert the enumerated entries into the reserve count numSponsoring actually
  // reports, then mirror detectSubEntryMismatch's direction: only an UNDERCOUNT is
  // dangerous. An equal-or-over total (a stale/racing read of numSponsoring, or the
  // pool-share imprecision above resolving the other way) must not raise a spurious
  // incomplete flag on a healthy account.
  let expectedReserves = 0;
  for (const entry of sponsoredEntries) {
    expectedReserves +=
      entry.kind === "claimable_balance"
        ? (claimantCountsByBalanceId.get(entry.balanceId) ?? 1)
        : RESERVES_PER_ENTRY[entry.kind];
  }
  const reserveUndercount = expectedReserves < numSponsoring;

  return {
    sponsoredEntries,
    sponsorshipEnumerationIncomplete:
      discoveryIncomplete || claimableBalanceIncomplete || anyLiveFetchFailed || reserveUndercount,
  };
}
