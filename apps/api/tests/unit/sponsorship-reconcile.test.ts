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

test("reconcileSponsoredEntries › enumerated count disagrees with ledger-truth numSponsoring → incomplete", () => {
  // Everything reported complete, but we only found 1 entry while the ledger says 2 -
  // mirrors detectSubEntryMismatch's philosophy: an undercount is never trusted silently.
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
