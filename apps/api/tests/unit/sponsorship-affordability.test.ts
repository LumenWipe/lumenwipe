import { test, expect, mock } from "bun:test";
import { assessSponsorshipAffordability } from "@/lib/stellar/sponsorship-affordability";
import type { SponsoredEntry } from "@lumenwipe/types";

// The closing account under test - must match the `sponsor` field every fixture below
// reports for entries it wants recognized as "still live-sponsored by us". Threaded as
// the first argument to every assessSponsorshipAffordability call in this file.
const SPONSOR = "GSPONSOR00000000000000000000000000000000000000000000000AAAA";
const OWNER = "GBOWNER00000000000000000000000000000000000000000000000AAAA";

mock.module("@/lib/stellar/sponsorship", () => ({
  fetchOwnerLiveState: mock(async (owner: string) => {
    if (owner !== OWNER) throw new Error(`unexpected owner ${owner}`);
    return {
      accountSponsor: null,
      trustlineSponsors: { "USDC:GISSUER": SPONSOR },
      signerSponsors: {},
      offerSponsors: {},
      dataSponsors: {},
      fetchFailed: false,
      reserve: { balanceLumens: "10.0000000", numSubEntries: 1, numSponsoring: 0, numSponsored: 1 },
    };
  }),
}));

test("assessSponsorshipAffordability › owner with enough spendable balance → entry is revocable", async () => {
  const entries: SponsoredEntry[] = [{ kind: "trustline", owner: OWNER, asset: "USDC:GISSUER" }];
  const result = await assessSponsorshipAffordability(SPONSOR, entries, "testnet");
  expect(result.revocable).toEqual(entries);
  expect(result.unaffordableOwners.size).toBe(0);
});

test("assessSponsorshipAffordability › owner without enough spendable balance → entry is unaffordable with a shortfall", async () => {
  mock.module("@/lib/stellar/sponsorship", () => ({
    fetchOwnerLiveState: mock(async () => ({
      accountSponsor: null,
      trustlineSponsors: { "USDC:GISSUER": SPONSOR },
      signerSponsors: {},
      offerSponsors: {},
      dataSponsors: {},
      fetchFailed: false,
      // minBalance today = (2 + 1 - 1) * 0.5 = 1.0, so this balance leaves zero spendable
      // margin - not enough for the extra 0.5 XLM the shifted trustline reserve needs.
      reserve: { balanceLumens: "1.0000000", numSubEntries: 1, numSponsoring: 0, numSponsored: 1 },
    })),
  }));
  const entries: SponsoredEntry[] = [{ kind: "trustline", owner: OWNER, asset: "USDC:GISSUER" }];
  const result = await assessSponsorshipAffordability(SPONSOR, entries, "testnet");
  expect(result.revocable).toEqual([]);
  expect(result.unaffordableOwners.get(OWNER)?.entries).toEqual(entries);
  expect(Number(result.unaffordableOwners.get(OWNER)?.shortfallXlm)).toBeGreaterThan(0);
});

test("assessSponsorshipAffordability › entry no longer live-sponsored by us → dropped silently, no step, no blocker", async () => {
  mock.module("@/lib/stellar/sponsorship", () => ({
    fetchOwnerLiveState: mock(async () => ({
      accountSponsor: null,
      trustlineSponsors: {
        "USDC:GISSUER": "GSOMEONEELSE0000000000000000000000000000000000000000000AAAA",
      },
      signerSponsors: {},
      offerSponsors: {},
      dataSponsors: {},
      fetchFailed: false,
      reserve: { balanceLumens: "10.0000000", numSubEntries: 1, numSponsoring: 0, numSponsored: 1 },
    })),
  }));
  const entries: SponsoredEntry[] = [{ kind: "trustline", owner: OWNER, asset: "USDC:GISSUER" }];
  const result = await assessSponsorshipAffordability(SPONSOR, entries, "testnet");
  expect(result.revocable).toEqual([]);
  expect(result.unaffordableOwners.size).toBe(0);
});

test("assessSponsorshipAffordability › mixed owners → affordable owner's entries revocable, unaffordable owner's entries blocked", async () => {
  const OWNER_B = "GBOWNERB0000000000000000000000000000000000000000000000AAAA";
  mock.module("@/lib/stellar/sponsorship", () => ({
    fetchOwnerLiveState: mock(async (owner: string) =>
      owner === OWNER
        ? {
            accountSponsor: null,
            trustlineSponsors: { "USDC:GISSUER": SPONSOR },
            signerSponsors: {},
            offerSponsors: {},
            dataSponsors: {},
            fetchFailed: false,
            reserve: {
              balanceLumens: "10.0000000",
              numSubEntries: 1,
              numSponsoring: 0,
              numSponsored: 1,
            },
          }
        : {
            accountSponsor: null,
            trustlineSponsors: { "USDC:GISSUER": SPONSOR },
            signerSponsors: {},
            offerSponsors: {},
            dataSponsors: {},
            fetchFailed: false,
            reserve: {
              balanceLumens: "1.0000000",
              numSubEntries: 1,
              numSponsoring: 0,
              numSponsored: 1,
            },
          }
    ),
  }));
  const entries: SponsoredEntry[] = [
    { kind: "trustline", owner: OWNER, asset: "USDC:GISSUER" },
    { kind: "trustline", owner: OWNER_B, asset: "USDC:GISSUER" },
  ];
  const result = await assessSponsorshipAffordability(SPONSOR, entries, "testnet");
  expect(result.revocable).toEqual([entries[0]]);
  expect(result.unaffordableOwners.has(OWNER_B)).toBe(true);
  expect(result.unaffordableOwners.has(OWNER)).toBe(false);
});
