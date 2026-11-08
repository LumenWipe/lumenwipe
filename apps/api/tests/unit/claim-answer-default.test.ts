import { expect, test } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import type { AccountState } from "@lumenwipe/types";
import { claimedAmountsPerAsset, deriveDecisionPoints } from "@/lib/close-api/decisions";
import { buildPlan } from "@/lib/stellar/tx-builder";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";
import { authorizationOf } from "./fixtures/trustline";
import { ALL_ON } from "@/config/kill-switches";

const MASTER = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const TRUSTED = `USDC:${ISSUER}`;
const UNTRUSTED = `EURC:${ISSUER}`;

function claimant(id: string, asset: string): AccountState["claimableBalances"][number] {
  return {
    id,
    asset,
    amount: "5.0000000",
    claimants: [{ destination: MASTER, predicate: { type: "unconditional" as const } }],
    sponsor: null,
  };
}

function account(): AccountState {
  return {
    address: MASTER,
    network: "testnet",
    sequence: "1",
    nativeBalanceLumens: "10.0000000",
    dataEntries: [],
    signers: [{ key: MASTER, weight: 1, type: "ed25519_public_key" }],
    thresholds: { low: 0, med: 1, high: 1 },
    numSubEntries: 1,
    numSponsoring: 0,
    sponsoredBy: null,
    authImmutable: false,
    trustlines: [
      {
        asset: TRUSTED,
        balance: "1.0000000",
        ...authorizationOf(true),
        issuer: ISSUER,
        code: "USDC",
      },
    ],
    openOffers: [],
    poolShares: [],
    claimableBalances: [
      claimant("claimable", TRUSTED),
      claimant("native", "native"),
      claimant("needs-trustline", UNTRUSTED),
    ],
    subEntryMismatch: false,
    sponsoredEntries: [],
    sponsorshipEnumerationIncomplete: false,
    defiPositions: emptyDefiPositionsResult(MASTER),
    defiPositionsWarnings: [],
  };
}

// The web skips the re-plan for a seeded "claim" on this equivalence (claimAnswersKey).
test("a claim answer plans exactly as no answer, whatever the balance's status", () => {
  const state = account();
  const answered = { claimable: "claim", native: "claim", "needs-trustline": "claim" } as const;

  expect([...claimedAmountsPerAsset(state, answered)]).toEqual([
    ...claimedAmountsPerAsset(state, {}),
  ]);
  expect(deriveDecisionPoints(state, { [TRUSTED]: true }, answered)).toEqual(
    deriveDecisionPoints(state, { [TRUSTED]: true }, {})
  );
  expect(buildPlan(ALL_ON, state, false, false, answered)).toEqual(
    buildPlan(ALL_ON, state, false, false, {})
  );
});

test("a forfeit is not equivalent, so the web still re-plans it", () => {
  const state = account();
  const forfeited = { claimable: "forfeit" } as const;
  expect(claimedAmountsPerAsset(state, forfeited).get(TRUSTED)).toBeUndefined();
  expect(claimedAmountsPerAsset(state, {}).get(TRUSTED)).toBe(50_000_000n);
  expect(buildPlan(ALL_ON, state, false, false, forfeited)).not.toEqual(
    buildPlan(ALL_ON, state, false, false, {})
  );
});
