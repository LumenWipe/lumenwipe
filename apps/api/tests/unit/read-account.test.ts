import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import type { AccountState } from "@lumenwipe/types";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";
import * as accountStateModule from "@/lib/stellar/account-state";
import { CLOSE_ROUND_TOKENS_BUDGET_MS, readAccountState } from "@/lib/close-api/read-account";

const ADDRESS = Keypair.random().publicKey();

const STATE: AccountState = {
  address: ADDRESS,
  network: "testnet",
  sequence: "100",
  nativeBalanceLumens: "5.0000000",
  dataEntries: [],
  signers: [{ key: ADDRESS, weight: 1, type: "ed25519_public_key" }],
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
  defiPositions: emptyDefiPositionsResult(ADDRESS),
  defiPositionsWarnings: [],
};

afterEach(() => mock.restore());

test("a close round reads the account with the quick token scan inside its budget, without the indexer", async () => {
  const read = spyOn(accountStateModule, "getAccountState").mockResolvedValue(STATE);
  const contract = StrKey.encodeContract(Buffer.alloc(32, 7));
  expect(await readAccountState(ADDRESS, "testnet", [contract])).toBe(STATE);
  expect(read).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledWith(ADDRESS, "testnet", {
    manualTokenCandidates: [contract],
    sorobanTokensBudgetMs: 8_000,
    scanTokenEvents: false,
    useTokenIndexer: false,
  });
  expect(CLOSE_ROUND_TOKENS_BUDGET_MS).toBe(8_000);
});

test("without named contracts a round passes no manual candidates", async () => {
  const read = spyOn(accountStateModule, "getAccountState").mockResolvedValue(STATE);
  await readAccountState(ADDRESS, "testnet");
  expect(read.mock.calls[0]?.[2]?.manualTokenCandidates).toEqual([]);
});
