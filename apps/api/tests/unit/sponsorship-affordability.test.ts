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
      poolShareSponsors: {},
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
  expect(result.unverifiedOwners).toEqual([]);
});

test("assessSponsorshipAffordability › owner without enough spendable balance → entry is unaffordable with a shortfall", async () => {
  statesFor({
    [OWNER]: {
      accountSponsor: null,
      trustlineSponsors: { "USDC:GISSUER": SPONSOR },
      poolShareSponsors: {},
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
      poolShareSponsors: {},
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
      poolShareSponsors: {},
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
      poolShareSponsors: {},
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
      poolShareSponsors: {},
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

test("assessSponsorshipAffordability › owner whose read fails → reported unverified, never dropped", async () => {
  statesFor({
    [OWNER]: {
      accountSponsor: null,
      trustlineSponsors: {},
      poolShareSponsors: {},
      signerSponsors: {},
      offerSponsors: {},
      dataSponsors: {},
      fetchFailed: true,
      reserve: null,
    },
  });
  const entries: SponsoredEntry[] = [{ kind: "trustline", owner: OWNER, asset: "USDC:GISSUER" }];
  const result = await assessSponsorshipAffordability(SPONSOR, entries, "testnet");
  expect(result.revocable).toEqual([]);
  expect(result.unaffordableOwners.size).toBe(0);
  expect(result.unverifiedOwners).toEqual([OWNER]);
});

test("assessSponsorshipAffordability › owner read without its reserve → reported unverified", async () => {
  statesFor({
    [OWNER]: {
      accountSponsor: null,
      trustlineSponsors: { "USDC:GISSUER": SPONSOR },
      poolShareSponsors: {},
      signerSponsors: {},
      offerSponsors: {},
      dataSponsors: {},
      fetchFailed: false,
      reserve: null,
    },
  });
  const entries: SponsoredEntry[] = [{ kind: "trustline", owner: OWNER, asset: "USDC:GISSUER" }];
  const result = await assessSponsorshipAffordability(SPONSOR, entries, "testnet");
  expect(result.revocable).toEqual([]);
  expect(result.unverifiedOwners).toEqual([OWNER]);
});

const POOL_ID = "d714bc2e56f74a4a4de2e81284a35b6fe09582f081bf785fc698310895c2d845";

function poolLineOwner(balanceLumens: string): OwnerLiveState {
  return {
    accountSponsor: null,
    trustlineSponsors: {},
    poolShareSponsors: { [POOL_ID]: SPONSOR },
    signerSponsors: {},
    offerSponsors: {},
    dataSponsors: {},
    fetchFailed: false,
    // A pool share line counts 2 sub-entries and is sponsored for both: the minimum balance today
    // is (2 + 2 - 2) * 0.5 = 1.0, and taking the line over costs 2 more base reserves, 1.0 XLM.
    reserve: {
      balanceLumens,
      numSubEntries: 2,
      numSponsoring: 0,
      numSponsored: 2,
      sellingLiabilities: "0",
    },
  };
}

test("assessSponsorshipAffordability › a pool share line is revocable when its owner can hold 2 base reserves of its own", async () => {
  statesFor({ [OWNER]: poolLineOwner("2.0000000") });
  const entries: SponsoredEntry[] = [
    { kind: "pool_share_trustline", owner: OWNER, poolId: POOL_ID },
  ];
  const result = await assessSponsorshipAffordability(SPONSOR, entries, "testnet");
  expect(result.revocable).toEqual(entries);
  expect(result.unaffordableOwners.size).toBe(0);
});

test("assessSponsorshipAffordability › a pool share line is unaffordable when its owner can hold only 1 base reserve more", async () => {
  statesFor({ [OWNER]: poolLineOwner("1.5000000") });
  const entries: SponsoredEntry[] = [
    { kind: "pool_share_trustline", owner: OWNER, poolId: POOL_ID },
  ];
  const result = await assessSponsorshipAffordability(SPONSOR, entries, "testnet");
  expect(result.revocable).toEqual([]);
  expect(result.unaffordableOwners.get(OWNER)).toEqual({ entries, shortfallXlm: "0.5000000" });
});

test("assessSponsorshipAffordability › a pool share line someone else now sponsors needs no revoke", async () => {
  statesFor({
    [OWNER]: { ...poolLineOwner("2.0000000"), poolShareSponsors: { [POOL_ID]: OWNER } },
  });
  const entries: SponsoredEntry[] = [
    { kind: "pool_share_trustline", owner: OWNER, poolId: POOL_ID },
  ];
  const result = await assessSponsorshipAffordability(SPONSOR, entries, "testnet");
  expect(result.revocable).toEqual([]);
  expect(result.unaffordableOwners.size).toBe(0);
});
