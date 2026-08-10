import { test, expect, mock, spyOn, afterEach } from "bun:test";
import { assessSponsorshipAffordability } from "@/lib/stellar/sponsorship-affordability";
import * as sponsorshipModule from "@/lib/stellar/sponsorship";
import type { OwnerLiveState } from "@/lib/stellar/sponsorship-reconcile";
import type { SponsoredEntry } from "@lumenwipe/types";

// spyOn (not mock.module) patches a single named export on the real, already-loaded
// module object and is reliably undone by mock.restore(). mock.module instead replaces
// the WHOLE module's export object, which - even after mock.restore() - was observed to
// keep other test files (tests/unit/sponsorship-io.test.ts, which imports and calls the
// REAL fetchOwnerLiveState/enumerateSponsoredEntries from this same module) reading the
// stubbed-out replacement for the remainder of the same `bun test` process. spyOn avoids
// that cross-file leakage entirely.
afterEach(() => {
  mock.restore();
});

// The closing account under test - must match the `sponsor` field every fixture below
// reports for entries it wants recognized as "still live-sponsored by us". Threaded as
// the first argument to every assessSponsorshipAffordability call in this file.
const SPONSOR = "GSPONSOR00000000000000000000000000000000000000000000000AAAA";
const OWNER = "GBOWNER00000000000000000000000000000000000000000000000AAAA";

// Installs the fetchOwnerLiveStatesBounded spy: given a lookup of owner -> live state,
// resolves to a Map scoped to whichever owners the caller actually asked for - mirroring
// the real helper's signature so assessSponsorshipAffordability doesn't need to know it's
// talking to a mock.
function statesFor(byOwner: Record<string, OwnerLiveState>) {
  spyOn(sponsorshipModule, "fetchOwnerLiveStatesBounded").mockImplementation(
    async (owners: string[]) => {
      const map = new Map<string, OwnerLiveState>();
      for (const owner of owners) {
        const state = byOwner[owner];
        if (!state) throw new Error(`unexpected owner ${owner}`);
        map.set(owner, state);
      }
      return map;
    }
  );
}

test("assessSponsorshipAffordability › owner with enough spendable balance → entry is revocable", async () => {
  statesFor({
    [OWNER]: {
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
        sellingLiabilities: "0",
      },
    },
  });
  const entries: SponsoredEntry[] = [{ kind: "trustline", owner: OWNER, asset: "USDC:GISSUER" }];
  const result = await assessSponsorshipAffordability(SPONSOR, entries, "testnet");
  expect(result.revocable).toEqual(entries);
  expect(result.unaffordableOwners.size).toBe(0);
});

test("assessSponsorshipAffordability › owner without enough spendable balance → entry is unaffordable with a shortfall", async () => {
  statesFor({
    [OWNER]: {
      accountSponsor: null,
      trustlineSponsors: { "USDC:GISSUER": SPONSOR },
      signerSponsors: {},
      offerSponsors: {},
      dataSponsors: {},
      fetchFailed: false,
      // minBalance today = (2 + 1 - 1) * 0.5 = 1.0, so this balance leaves zero spendable
      // margin - not enough for the extra 0.5 XLM the shifted trustline reserve needs.
      reserve: {
        balanceLumens: "1.0000000",
        numSubEntries: 1,
        numSponsoring: 0,
        numSponsored: 1,
        sellingLiabilities: "0",
      },
    },
  });
  const entries: SponsoredEntry[] = [{ kind: "trustline", owner: OWNER, asset: "USDC:GISSUER" }];
  const result = await assessSponsorshipAffordability(SPONSOR, entries, "testnet");
  expect(result.revocable).toEqual([]);
  expect(result.unaffordableOwners.get(OWNER)?.entries).toEqual(entries);
  expect(Number(result.unaffordableOwners.get(OWNER)?.shortfallXlm)).toBeGreaterThan(0);
});

test("assessSponsorshipAffordability › owner with sufficient raw balance but selling liabilities eating the margin → entry is unaffordable", async () => {
  statesFor({
    [OWNER]: {
      accountSponsor: null,
      trustlineSponsors: { "USDC:GISSUER": SPONSOR },
      signerSponsors: {},
      offerSponsors: {},
      dataSponsors: {},
      fetchFailed: false,
      // minBalance = (2 + 1 - 1) * 0.5 = 1.0. Raw balance of 2.0 looks like it leaves 1.0
      // XLM of spendable margin - comfortably above the 0.5 XLM the shifted trustline
      // reserve needs - but 0.6 XLM is tied up in an open sell offer's selling
      // liabilities, which stellar-core's own LOW_RESERVE gate subtracts before
      // comparing. The true available balance (0.4) is below the 0.5 needed.
      reserve: {
        balanceLumens: "2.0000000",
        numSubEntries: 1,
        numSponsoring: 0,
        numSponsored: 1,
        sellingLiabilities: "0.6000000",
      },
    },
  });
  const entries: SponsoredEntry[] = [{ kind: "trustline", owner: OWNER, asset: "USDC:GISSUER" }];
  const result = await assessSponsorshipAffordability(SPONSOR, entries, "testnet");
  expect(result.revocable).toEqual([]);
  expect(result.unaffordableOwners.get(OWNER)?.entries).toEqual(entries);
  expect(Number(result.unaffordableOwners.get(OWNER)?.shortfallXlm)).toBeGreaterThan(0);
});

test("assessSponsorshipAffordability › entry no longer live-sponsored by us → dropped silently, no step, no blocker", async () => {
  statesFor({
    [OWNER]: {
      accountSponsor: null,
      trustlineSponsors: {
        "USDC:GISSUER": "GSOMEONEELSE0000000000000000000000000000000000000000000AAAA",
      },
      signerSponsors: {},
      offerSponsors: {},
      dataSponsors: {},
      fetchFailed: false,
      reserve: {
        balanceLumens: "10.0000000",
        numSubEntries: 1,
        numSponsoring: 0,
        numSponsored: 1,
        sellingLiabilities: "0",
      },
    },
  });
  const entries: SponsoredEntry[] = [{ kind: "trustline", owner: OWNER, asset: "USDC:GISSUER" }];
  const result = await assessSponsorshipAffordability(SPONSOR, entries, "testnet");
  expect(result.revocable).toEqual([]);
  expect(result.unaffordableOwners.size).toBe(0);
});

test("assessSponsorshipAffordability › mixed owners → affordable owner's entries revocable, unaffordable owner's entries blocked", async () => {
  const OWNER_B = "GBOWNERB0000000000000000000000000000000000000000000000AAAA";
  statesFor({
    [OWNER]: {
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
        sellingLiabilities: "0",
      },
    },
    [OWNER_B]: {
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
        sellingLiabilities: "0",
      },
    },
  });
  const entries: SponsoredEntry[] = [
    { kind: "trustline", owner: OWNER, asset: "USDC:GISSUER" },
    { kind: "trustline", owner: OWNER_B, asset: "USDC:GISSUER" },
  ];
  const result = await assessSponsorshipAffordability(SPONSOR, entries, "testnet");
  expect(result.revocable).toEqual([entries[0]]);
  expect(result.unaffordableOwners.has(OWNER_B)).toBe(true);
  expect(result.unaffordableOwners.has(OWNER)).toBe(false);
});
