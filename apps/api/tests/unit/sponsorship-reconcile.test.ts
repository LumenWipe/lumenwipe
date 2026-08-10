import { test, expect } from "bun:test";
import {
  reconcileSponsoredEntries,
  type SponsorshipCandidate,
  type OwnerLiveState,
} from "@/lib/stellar/sponsorship-reconcile";
import type { SponsoredEntry } from "@lumenwipe/types";

const SPONSOR = "GSPONSOR000000000000000000000000000000000000000000000";
const OTHER_SPONSOR = "GOTHER0000000000000000000000000000000000000000000000";
const OWNER = "GOWNER00000000000000000000000000000000000000000000000";

function liveState(overrides: Partial<OwnerLiveState> = {}): OwnerLiveState {
  return {
    accountSponsor: null,
    trustlineSponsors: {},
    signerSponsors: {},
    offerSponsors: {},
    dataSponsors: {},
    fetchFailed: false,
    reserve: null,
    ...overrides,
  };
}

test("reconcileSponsoredEntries › entry sponsored then later un-sponsored (net zero) → excluded", () => {
  const candidates: SponsorshipCandidate[] = [
    {
      kind: "trustline",
      owner: OWNER,
      key: "USD:GISSUER0000000000000000000000000000000000000000000",
    },
  ];
  const liveStateByOwner = new Map([
    [
      OWNER,
      liveState({
        trustlineSponsors: { "USD:GISSUER0000000000000000000000000000000000000000000": null },
      }),
    ],
  ]);

  const result = reconcileSponsoredEntries(
    SPONSOR,
    candidates,
    liveStateByOwner,
    [],
    false,
    false,
    0
  );

  expect(result.sponsoredEntries).toEqual([]);
  expect(result.sponsorshipEnumerationIncomplete).toBe(false);
});

test("reconcileSponsoredEntries › entry re-sponsored by a different account → excluded", () => {
  const candidates: SponsorshipCandidate[] = [
    {
      kind: "trustline",
      owner: OWNER,
      key: "USD:GISSUER0000000000000000000000000000000000000000000",
    },
  ];
  const liveStateByOwner = new Map([
    [
      OWNER,
      liveState({
        trustlineSponsors: {
          "USD:GISSUER0000000000000000000000000000000000000000000": OTHER_SPONSOR,
        },
      }),
    ],
  ]);

  const result = reconcileSponsoredEntries(
    SPONSOR,
    candidates,
    liveStateByOwner,
    [],
    false,
    false,
    0
  );

  expect(result.sponsoredEntries).toEqual([]);
  expect(result.sponsorshipEnumerationIncomplete).toBe(false);
});

test("reconcileSponsoredEntries › still-current sponsorship → included with the right shape", () => {
  const candidates: SponsorshipCandidate[] = [
    {
      kind: "trustline",
      owner: OWNER,
      key: "USD:GISSUER0000000000000000000000000000000000000000000",
    },
    { kind: "signer", owner: OWNER, key: "GSIGNER00000000000000000000000000000000000000000000000" },
    { kind: "account", owner: OWNER, key: "" },
  ];
  const liveStateByOwner = new Map([
    [
      OWNER,
      liveState({
        accountSponsor: SPONSOR,
        trustlineSponsors: { "USD:GISSUER0000000000000000000000000000000000000000000": SPONSOR },
        signerSponsors: { GSIGNER00000000000000000000000000000000000000000000000: SPONSOR },
      }),
    ],
  ]);

  const result = reconcileSponsoredEntries(
    SPONSOR,
    candidates,
    liveStateByOwner,
    [],
    false,
    false,
    3
  );

  expect(result.sponsoredEntries).toContainEqual({ kind: "account", owner: OWNER });
  expect(result.sponsoredEntries).toContainEqual({
    kind: "trustline",
    owner: OWNER,
    asset: "USD:GISSUER0000000000000000000000000000000000000000000",
  });
  expect(result.sponsoredEntries).toContainEqual({
    kind: "signer",
    owner: OWNER,
    signerKey: "GSIGNER00000000000000000000000000000000000000000000000",
  });
  expect(result.sponsoredEntries).toHaveLength(3);
  expect(result.sponsorshipEnumerationIncomplete).toBe(false);
});

test("reconcileSponsoredEntries › offer candidates sweep the owner's full current offer list", () => {
  const candidates: SponsorshipCandidate[] = [{ kind: "offer", owner: OWNER, key: "" }];
  const liveStateByOwner = new Map([
    [OWNER, liveState({ offerSponsors: { "12345": SPONSOR, "67890": OTHER_SPONSOR } })],
  ]);

  const result = reconcileSponsoredEntries(
    SPONSOR,
    candidates,
    liveStateByOwner,
    [],
    false,
    false,
    1
  );

  expect(result.sponsoredEntries).toEqual([{ kind: "offer", owner: OWNER, offerId: "12345" }]);
  expect(result.sponsorshipEnumerationIncomplete).toBe(false);
});

test("reconcileSponsoredEntries › claimable balances pass through directly", () => {
  const cbEntries: SponsoredEntry[] = [{ kind: "claimable_balance", balanceId: "00000000abc" }];

  const result = reconcileSponsoredEntries(SPONSOR, [], new Map(), cbEntries, false, false, 1);

  expect(result.sponsoredEntries).toEqual(cbEntries);
  expect(result.sponsorshipEnumerationIncomplete).toBe(false);
});

test("reconcileSponsoredEntries › paginated operations history cut off mid-scan → incomplete", () => {
  const result = reconcileSponsoredEntries(SPONSOR, [], new Map(), [], true, false, 0);

  expect(result.sponsorshipEnumerationIncomplete).toBe(true);
});

test("reconcileSponsoredEntries › claimable balance list truncated → incomplete", () => {
  const result = reconcileSponsoredEntries(SPONSOR, [], new Map(), [], false, true, 0);

  expect(result.sponsorshipEnumerationIncomplete).toBe(true);
});

test("reconcileSponsoredEntries › a live re-verification fetch failed → incomplete even though nothing else did", () => {
  const candidates: SponsorshipCandidate[] = [{ kind: "trustline", owner: OWNER, key: "native" }];
  const liveStateByOwner = new Map([[OWNER, liveState({ fetchFailed: true })]]);

  const result = reconcileSponsoredEntries(
    SPONSOR,
    candidates,
    liveStateByOwner,
    [],
    false,
    false,
    1
  );

  expect(result.sponsorshipEnumerationIncomplete).toBe(true);
});

test("reconcileSponsoredEntries › enumerated reserves fall short of ledger-truth numSponsoring → incomplete", () => {
  // One sponsored trustline costs exactly 1 reserve, but the ledger reports 2 sponsored
  // reserves - something real was missed. Mirrors detectSubEntryMismatch's philosophy:
  // an undercount is never trusted silently.
  const candidates: SponsorshipCandidate[] = [{ kind: "trustline", owner: OWNER, key: "native" }];
  const liveStateByOwner = new Map([
    [OWNER, liveState({ trustlineSponsors: { native: SPONSOR } })],
  ]);

  const result = reconcileSponsoredEntries(
    SPONSOR,
    candidates,
    liveStateByOwner,
    [],
    false,
    false,
    2
  );

  expect(result.sponsoredEntries).toHaveLength(1);
  expect(result.sponsorshipEnumerationIncomplete).toBe(true);
});

test("reconcileSponsoredEntries › a 2-claimant claimable balance costs 2 reserves → not incomplete", () => {
  // The single most common real-world pattern (a reclaimable balance has 2 claimants:
  // the recipient and the sender). numSponsoring counts RESERVES, so 1 entry against
  // numSponsoring: 2 is a perfectly healthy account, not an undercount.
  const cbEntries: SponsoredEntry[] = [{ kind: "claimable_balance", balanceId: "00000000abc" }];

  const result = reconcileSponsoredEntries(
    SPONSOR,
    [],
    new Map(),
    cbEntries,
    false,
    false,
    2,
    new Map([["00000000abc", 2]])
  );

  expect(result.sponsoredEntries).toEqual(cbEntries);
  expect(result.sponsorshipEnumerationIncomplete).toBe(false);
});

test("reconcileSponsoredEntries › many multi-claimant claimable balances → no false incomplete flag", () => {
  // Regression guard for the shape observed on a real testnet account: 87 enumerated
  // claimable-balance entries carrying 189 claimants between them, reported by the
  // ledger as numSponsoring: 189. Comparing entry count to reserve count flagged this
  // fully-enumerated account as incomplete on every single read.
  const cbEntries: SponsoredEntry[] = [];
  const claimantCounts = new Map<string, number>();
  let totalClaimants = 0;
  for (let i = 0; i < 87; i++) {
    const balanceId = `000000000000000000000000000000000000000000000000000000000000${i}`;
    const claimants = i < 15 ? 3 : 2; // 15*3 + 72*2 = 189
    cbEntries.push({ kind: "claimable_balance", balanceId });
    claimantCounts.set(balanceId, claimants);
    totalClaimants += claimants;
  }
  expect(totalClaimants).toBe(189);

  const result = reconcileSponsoredEntries(
    SPONSOR,
    [],
    new Map(),
    cbEntries,
    false,
    false,
    totalClaimants,
    claimantCounts
  );

  expect(result.sponsoredEntries).toHaveLength(87);
  expect(result.sponsorshipEnumerationIncomplete).toBe(false);
});

test("reconcileSponsoredEntries › a sponsored account creation costs 2 reserves → not incomplete", () => {
  // Wallet-onboarding sponsorship: one sponsored account entry, 2 base reserves.
  const candidates: SponsorshipCandidate[] = [{ kind: "account", owner: OWNER, key: "" }];
  const liveStateByOwner = new Map([[OWNER, liveState({ accountSponsor: SPONSOR })]]);

  const result = reconcileSponsoredEntries(
    SPONSOR,
    candidates,
    liveStateByOwner,
    [],
    false,
    false,
    2
  );

  expect(result.sponsoredEntries).toEqual([{ kind: "account", owner: OWNER }]);
  expect(result.sponsorshipEnumerationIncomplete).toBe(false);
});

test("reconcileSponsoredEntries › enumerated reserves exceed a stale numSponsoring → not incomplete", () => {
  // Only an undercount is dangerous. An over-count (a stale or racing numSponsoring read)
  // must not raise a spurious incomplete flag - nothing can have been silently dropped.
  const candidates: SponsorshipCandidate[] = [{ kind: "trustline", owner: OWNER, key: "native" }];
  const liveStateByOwner = new Map([
    [OWNER, liveState({ trustlineSponsors: { native: SPONSOR } })],
  ]);

  const result = reconcileSponsoredEntries(
    SPONSOR,
    candidates,
    liveStateByOwner,
    [],
    false,
    false,
    0
  );

  expect(result.sponsoredEntries).toHaveLength(1);
  expect(result.sponsorshipEnumerationIncomplete).toBe(false);
});
