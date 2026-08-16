import { test, expect } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import { detectSubEntryMismatch } from "@/lib/stellar/scan-fallback";
import type { AccountState, Trustline } from "@lumenwipe/types";

const MASTER = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();

function makeAccount(overrides: Partial<AccountState> = {}): AccountState {
  return {
    address: MASTER,
    network: "testnet",
    sequence: "1234567890",
    nativeBalanceLumens: "10.0000000",
    dataEntries: [],
    signers: [{ key: MASTER, weight: 1, type: "ed25519_public_key" }],
    thresholds: { low: 0, med: 1, high: 1 },
    numSubEntries: 0,
    numSponsoring: 0,
    sponsoredBy: null,
    authImmutable: false,
    trustlines: [],
    openOffers: [],
    poolShares: [],
    claimableBalances: [],
    subEntryMismatch: false,
    sponsoredEntries: [],
    sponsorshipEnumerationIncomplete: false,
    ...overrides,
  };
}

function makeTrustline(code: string): Trustline {
  return {
    asset: `${code}:${ISSUER}`,
    balance: "1.0000000",
    limit: "922337203685.4775807",
    authorized: true,
    issuer: ISSUER,
    code,
  };
}

test("detectSubEntryMismatch › undercounted scan → mismatch", () => {
  // The stellar.expert account-stats endpoint never returns manage-data
  // entries, so a playground account (3 trustlines + 3 offers + 3 data
  // entries + 1 signer = 10 sub-entries) enumerates only 7 via that path.
  const mismatch = detectSubEntryMismatch({
    address: MASTER,
    signers: [
      { key: MASTER, weight: 1, type: "ed25519_public_key" },
      { key: ISSUER, weight: 1, type: "ed25519_public_key" },
    ],
    trustlines: [makeTrustline("AIRDROP1"), makeTrustline("RUGPULL"), makeTrustline("LWDEMO")],
    openOffers: [
      { id: "1", selling: "native", buying: `LWDEMO:${ISSUER}`, amount: "5", price: "2" },
      {
        id: "2",
        selling: `AIRDROP1:${ISSUER}`,
        buying: "native",
        amount: "500000",
        price: "0.0001",
      },
      { id: "3", selling: `RUGPULL:${ISSUER}`, buying: "native", amount: "10", price: "42" },
    ],
    dataEntries: [],
    poolShares: [],
    numSubEntries: 10,
  });
  expect(mismatch).toBe(true);
});

test("detectSubEntryMismatch › fully enumerated account → no mismatch", () => {
  const mismatch = detectSubEntryMismatch({
    address: MASTER,
    signers: [{ key: MASTER, weight: 1, type: "ed25519_public_key" }],
    trustlines: [makeTrustline("LWDEMO")],
    openOffers: [],
    dataEntries: [
      { key: "promo_code", value: "V0VMQ09NRTIwMjQ=" },
      { key: "airdrop_claim", value: "cGVuZGluZw==" },
    ],
    poolShares: [],
    numSubEntries: 3,
  });
  expect(mismatch).toBe(false);
});

test("detectSubEntryMismatch › pool shares weigh 2 sub-entries each", () => {
  const scan = {
    address: MASTER,
    signers: [{ key: MASTER, weight: 1, type: "ed25519_public_key" as const }],
    trustlines: [],
    openOffers: [],
    dataEntries: [],
    poolShares: [{ poolId: "a".repeat(64) }],
    numSubEntries: 2,
  };
  expect(detectSubEntryMismatch(scan)).toBe(false);
  expect(detectSubEntryMismatch({ ...scan, numSubEntries: 3 })).toBe(true);
});

// The three cases below used to assert that a mismatch merely triggered a re-read through a
// second, zero-lag path. That two-step existed because the primary source was an indexer that
// lagged on new accounts and never returned manage-data entries at all. With a single zero-lag
// provider there is nothing to re-check against, so the mismatch itself is the answer and
// reaches the plan builder as a blocker. What still has to hold is that these shapes are
// detected as mismatches in the first place.

test("a partially enumerated account is a mismatch (trustlines seen, data entries missing)", () => {
  // Repro for the playground -> /testnet false blocker: 3 trustlines and 3 offers enumerated
  // while the ledger reported 10 sub-entries.
  expect(
    detectSubEntryMismatch({
      address: MASTER,
      signers: [{ key: MASTER, weight: 1, type: "ed25519_public_key" }],
      trustlines: [makeTrustline("AIRDROP1"), makeTrustline("RUGPULL"), makeTrustline("LWDEMO")],
      openOffers: [
        { id: "1", selling: "native", buying: `LWDEMO:${ISSUER}`, amount: "5", price: "2" },
        {
          id: "2",
          selling: `AIRDROP1:${ISSUER}`,
          buying: "native",
          amount: "500000",
          price: "0.0001",
        },
        { id: "3", selling: `RUGPULL:${ISSUER}`, buying: "native", amount: "10", price: "42" },
      ],
      dataEntries: [],
      poolShares: [],
      numSubEntries: 10,
    })
  ).toBe(true);
});

test("an account enumerated as empty against a non-zero ledger count is a mismatch", () => {
  expect(
    detectSubEntryMismatch({
      address: MASTER,
      signers: [{ key: MASTER, weight: 1, type: "ed25519_public_key" }],
      trustlines: [],
      openOffers: [],
      dataEntries: [],
      poolShares: [],
      numSubEntries: 10,
    })
  ).toBe(true);
});
