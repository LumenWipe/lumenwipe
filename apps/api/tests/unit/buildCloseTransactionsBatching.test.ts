import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as rpcModule from "@/lib/stellar/rpc";
import { Account, Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import type { AccountState, Trustline } from "@lumenwipe/types";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";

// Wiring coverage for #59: a direct (no-mediator) close whose op count spills past
// OP_BATCH_LIMIT used to be returned as every chunk at once with `requiresAnotherCall: false`,
// even though every chunk shares one time bound computed at the top of this call - submitting
// them all in sequence can outrun that bound on a large enough account and expire the later
// chunks, including the one carrying the merge. This drives the real `buildCloseTransactions`
// (not just `packFusedCloseTransactions`, which only tests the chunking math itself) to confirm
// the higher-level round contract that fixes it.

const SOURCE = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();

function manyTrustlines(n: number): Trustline[] {
  return Array.from({ length: n }, (_, i) => ({
    asset: `AST${i}:${ISSUER}`,
    balance: "0",
    authorized: true,
    issuer: ISSUER,
    code: `AST${i}`,
    limit: "1000",
  }));
}

function accountState(over: Partial<AccountState> = {}): AccountState {
  return {
    address: SOURCE,
    network: "testnet",
    sequence: "100",
    nativeBalanceLumens: "10000.0000000",
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

function rpcServerStub() {
  return {
    getAccount: () => Promise.resolve(new Account(SOURCE, "100")),
    getLatestLedger: () => Promise.resolve({ sequence: 1000 }),
    getLedgerEntries: () => Promise.reject(new Error("not stubbed")),
    getAssetBalance: () => Promise.reject(new Error("not stubbed")),
  };
}

afterEach(() => {
  mock.restore();
});

function opsOf(xdr: string) {
  return TransactionBuilder.fromXDR(xdr, Networks.TESTNET).operations;
}

test("a direct close under the op cap still finishes in one round", async () => {
  spyOn(rpcModule, "getRpcServer").mockImplementation((() =>
    rpcServerStub()) as unknown as typeof rpcModule.getRpcServer);
  const { buildCloseTransactions } = await import("@/lib/close-api/build-transactions");

  const state = accountState({ trustlines: manyTrustlines(3), numSubEntries: 3 });
  const result = await buildCloseTransactions(state, DEST, {}, "testnet");

  expect(result.transactions).toHaveLength(1);
  expect(result.requiresAnotherCall).toBe(false);
  expect(result.remainingSteps).toBe(0);
  expect(opsOf(result.transactions[0]!.xdr).some((o) => o.type === "accountMerge")).toBe(true);
});

test("a direct close over the op cap asks for another call instead of expiring later chunks", async () => {
  spyOn(rpcModule, "getRpcServer").mockImplementation((() =>
    rpcServerStub()) as unknown as typeof rpcModule.getRpcServer);
  const { buildCloseTransactions } = await import("@/lib/close-api/build-transactions");

  const state = accountState({ trustlines: manyTrustlines(150), numSubEntries: 150 });
  const result = await buildCloseTransactions(state, DEST, {}, "testnet");

  // Only the first chunk is handed back - not all of them sharing one time bound - and the
  // merge (which packFusedCloseTransactions only ever puts on the last chunk) is not in it.
  expect(result.transactions).toHaveLength(1);
  expect(result.requiresAnotherCall).toBe(true);
  expect(result.remainingSteps).toBeGreaterThan(0);
  expect(opsOf(result.transactions[0]!.xdr).some((o) => o.type === "accountMerge")).toBe(false);
});

test("a follow-up call against the reduced live state converges to the merge", async () => {
  spyOn(rpcModule, "getRpcServer").mockImplementation((() =>
    rpcServerStub()) as unknown as typeof rpcModule.getRpcServer);
  const { buildCloseTransactions } = await import("@/lib/close-api/build-transactions");

  // Simulates the state after the first round's chunk landed: far fewer trustlines left.
  const state = accountState({ trustlines: manyTrustlines(2), numSubEntries: 2 });
  const result = await buildCloseTransactions(state, DEST, {}, "testnet");

  expect(result.transactions).toHaveLength(1);
  expect(result.requiresAnotherCall).toBe(false);
  expect(opsOf(result.transactions[0]!.xdr).some((o) => o.type === "accountMerge")).toBe(true);
});
