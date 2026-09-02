import { expect, test } from "bun:test";
import { Asset, Keypair, Networks } from "@stellar/stellar-sdk";
import type { AccountState } from "@lumenwipe/types";
import { tokenBalancesFor } from "@/lib/defi-exits/token-balances";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";

const SOURCE = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();

function account(over: Partial<AccountState> = {}): AccountState {
  return {
    address: SOURCE,
    network: "testnet",
    sequence: "1",
    nativeBalanceLumens: "12.5000000",
    dataEntries: [],
    signers: [{ key: SOURCE, weight: 1, type: "ed25519_public_key" }],
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
    defiPositions: emptyDefiPositionsResult(SOURCE),
    defiPositionsWarnings: [],
    ...over,
  };
}

// 12.5 XLM held; 1 XLM base reserve and 0.01 XLM fee margin are not spendable.
const NATIVE_SPENDABLE = "114900000";

test("keys native XLM and every authorized trustline by its Stellar Asset Contract, in base units", () => {
  const balances = tokenBalancesFor(
    account({
      trustlines: [
        {
          asset: `USDC:${ISSUER}`,
          code: "USDC",
          issuer: ISSUER,
          balance: "50.1234567",
          authorized: true,
        },
        {
          asset: `JUNK:${ISSUER}`,
          code: "JUNK",
          issuer: ISSUER,
          balance: "9.0000000",
          authorized: false,
        },
      ],
    })
  );
  expect(balances[Asset.native().contractId(Networks.TESTNET)]).toBe(NATIVE_SPENDABLE);
  expect(balances[new Asset("USDC", ISSUER).contractId(Networks.TESTNET)]).toBe("501234567");
  // Unauthorized cannot be spent: omitted, so the adapter reports "unknown", not "zero".
  expect(balances[new Asset("JUNK", ISSUER).contractId(Networks.TESTNET)]).toBeUndefined();
  expect(Object.keys(balances)).toHaveLength(2);
});

test("the network decides the contract id - the same asset has a different SAC on mainnet", () => {
  const testnet = tokenBalancesFor(account());
  const mainnet = tokenBalancesFor(account({ network: "mainnet" }));
  expect(Object.keys(testnet)[0]).not.toBe(Object.keys(mainnet)[0]);
  expect(Object.keys(mainnet)[0]).toBe(Asset.native().contractId(Networks.PUBLIC));
});

test("reports what is spendable: the reserve grows with every subentry and sponsorship", () => {
  // 2 trustlines + 1 sponsored entry = 3 x 0.5 XLM on top of the 1 XLM base reserve.
  const balances = tokenBalancesFor(account({ numSubEntries: 2, numSponsoring: 1 }));
  expect(balances[Asset.native().contractId(Networks.TESTNET)]).toBe("99900000");
});

test("what an open offer is selling is held by the ledger and not spendable by a repay", () => {
  const balances = tokenBalancesFor(
    account({
      trustlines: [
        {
          asset: `USDC:${ISSUER}`,
          code: "USDC",
          issuer: ISSUER,
          balance: "50.0000000",
          authorized: true,
        },
      ],
      openOffers: [
        { id: "1", selling: `USDC:${ISSUER}`, buying: "native", amount: "20.0000000", price: "1" },
        { id: "2", selling: "native", buying: `USDC:${ISSUER}`, amount: "2.0000000", price: "1" },
        // Buying an asset holds nothing of it back.
        { id: "3", selling: "native", buying: `USDC:${ISSUER}`, amount: "1.0000000", price: "1" },
      ],
    })
  );
  expect(balances[new Asset("USDC", ISSUER).contractId(Networks.TESTNET)]).toBe("300000000");
  expect(balances[Asset.native().contractId(Networks.TESTNET)]).toBe("84900000");
});

test("a balance entirely held back reports zero, never a negative amount", () => {
  const balances = tokenBalancesFor(account({ nativeBalanceLumens: "1.0000000" }));
  expect(balances[Asset.native().contractId(Networks.TESTNET)]).toBe("0");
});
