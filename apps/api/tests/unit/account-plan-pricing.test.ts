import { test, expect } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import { pricedAmountsPerAsset } from "@/lib/close-api/account-plan";
import { claimedAmountsPerAsset } from "@/lib/close-api/decisions";
import type { AccountState } from "@lumenwipe/types";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";

const MASTER = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const ASSET = `USDC:${ISSUER}`;

function account(held: string, claims: string[]): AccountState {
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
    trustlines: [{ asset: ASSET, balance: held, authorized: true, issuer: ISSUER, code: "USDC" }],
    openOffers: [],
    poolShares: [],
    claimableBalances: claims.map((amount, i) => ({
      id: `cb${i}`,
      asset: ASSET,
      amount,
      claimants: [{ destination: MASTER, predicate: { type: "unconditional" as const } }],
      sponsor: null,
    })),
    subEntryMismatch: false,
    sponsoredEntries: [],
    sponsorshipEnumerationIncomplete: false,
    defiPositions: emptyDefiPositionsResult(MASTER),
    defiPositionsWarnings: [],
  };
}

function priced(held: string, claims: string[]): string | undefined {
  const state = account(held, claims);
  const claimed = claimedAmountsPerAsset(state, {});
  return pricedAmountsPerAsset(state, claimed).find((p) => p.asset === ASSET)?.amount;
}

test("the priced quote amount is the exact stroop sum", () => {
  expect(priced("0.0000001", [])).toBe("0.0000001");
  expect(priced("0.0000001", ["0.0000001"])).toBe("0.0000002");
  expect(priced("0.0000001", ["0.0000001", "0.0000001", "0.0000001"])).toBe("0.0000004");
  expect(priced("922337203685.4775807", [])).toBe("922337203685.4775807");
  expect(priced("922337203685.4775806", ["0.0000001"])).toBe("922337203685.4775807");
  expect(priced("0.0000000", ["0.1000000", "0.2000000"])).toBe("0.3000000");
});
