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
}

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
  numSponsoring: number
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

    if (candidate.kind === "offer") {
      for (const [offerId, sponsor] of Object.entries(live.offerSponsors)) {
        if (sponsor !== address) continue;
        const dedupeKey = `offer:${candidate.owner}:${offerId}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        sponsoredEntries.push({ kind: "offer", owner: candidate.owner, offerId });
      }
      continue;
    }

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

  const countMismatch = sponsoredEntries.length !== numSponsoring;

  return {
    sponsoredEntries,
    sponsorshipEnumerationIncomplete:
      discoveryIncomplete || claimableBalanceIncomplete || anyLiveFetchFailed || countMismatch,
  };
}
