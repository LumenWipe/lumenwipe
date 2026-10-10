import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Account, Keypair } from "@stellar/stellar-sdk";
import type { AccountState, CloseTransaction, Trustline } from "@lumenwipe/types";
import { emptyLines } from "./fixtures/ledger-trustlines";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";
import * as rpcModule from "@/lib/stellar/rpc";
import { buildPlan } from "@/lib/stellar/tx-builder";
import { toExecutionBreakdown } from "@/lib/close-api/plan-response";

const SOURCE = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();

function trustlines(n: number): Trustline[] {
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

afterEach(() => {
  mock.restore();
});

function stubRpc(): void {
  spyOn(rpcModule, "getRpcServer").mockImplementation((() => ({
    getAccount: () => Promise.resolve(new Account(SOURCE, "100")),
    getLatestLedger: () => Promise.resolve({ sequence: 1000 }),
    getLedgerEntries: emptyLines,
  })) as unknown as typeof rpcModule.getRpcServer);
}

async function stubMediator(): Promise<void> {
  const registry = await import("@/lib/exchange-registry");
  const networks = await import("@/config/networks");
  spyOn(registry, "requiresMediatorForAddress").mockReturnValue(true);
  spyOn(networks, "getMediatorPublicKey").mockReturnValue(Keypair.random().publicKey());
}

/** What the plan reports, and what the builder returns summed over every round, the state
 *  between rounds being whatever `advance` says the previous round left behind. */
async function planned(state: AccountState, viaMediator: boolean) {
  const { steps } = buildPlan(state, viaMediator);
  return toExecutionBreakdown(steps, { viaMediator, decided: true });
}

async function built(
  initial: AccountState,
  advance: (state: AccountState, round: CloseTransaction[], index: number) => AccountState
): Promise<{ count: number; covers: CloseTransaction["covers"][] }> {
  const { buildCloseTransactions } = await import("@/lib/close-api/build-transactions");
  const covers: CloseTransaction["covers"][] = [];
  let state = initial;
  for (let round = 0; round < 10; round++) {
    const result = await buildCloseTransactions(state, DEST, {}, "testnet");
    for (const tx of result.transactions) covers.push(tx.covers);
    if (!result.requiresAnotherCall) return { count: covers.length, covers };
    state = advance(state, result.transactions, round);
  }
  throw new Error("the close did not converge");
}

test("a single-transaction account reports 1, the number the builder returns", async () => {
  stubRpc();
  const state = accountState({
    trustlines: trustlines(3),
    dataEntries: [{ key: "k", value: "v" }],
    numSubEntries: 4,
  });
  const plan = await planned(state, false);
  const actual = await built(state, (s) => s);
  expect(actual.count).toBe(1);
  expect(plan.estimatedTransactionCount).toBe(actual.count);
  expect(plan.transactions.map((t) => t.covers)).toEqual(actual.covers);
});

test("an exchange via the mediator reports the cleanup and the mediator transfer", async () => {
  stubRpc();
  await stubMediator();
  const state = accountState({ trustlines: trustlines(3), numSubEntries: 3 });
  const plan = await planned(state, true);
  const actual = await built(state, (s) => ({ ...s, trustlines: [], numSubEntries: 0 }));
  expect(actual.count).toBe(2);
  expect(plan.estimatedTransactionCount).toBe(actual.count);
  expect(plan.transactions.map((t) => t.covers)).toEqual(actual.covers);
});

test("a claimable-balance account reports the claim round and the close", async () => {
  stubRpc();
  const state = accountState({
    trustlines: trustlines(2),
    numSubEntries: 3,
    claimableBalances: [
      {
        id: `00000000${"a".repeat(64)}`,
        asset: "native",
        amount: "10.0000000",
        claimants: [{ destination: SOURCE, predicate: { type: "unconditional" } }],
        sponsor: null,
      },
    ],
  });
  const plan = await planned(state, false);
  const actual = await built(state, (s) => ({ ...s, claimableBalances: [] }));
  expect(actual.count).toBe(2);
  expect(plan.estimatedTransactionCount).toBe(actual.count);
  expect(plan.transactions.map((t) => t.covers)).toEqual(actual.covers);
});

test("an account over 100 operations reports every chunk the builder returns", async () => {
  stubRpc();
  const state = accountState({ trustlines: trustlines(150), numSubEntries: 150 });
  const plan = await planned(state, false);
  const actual = await built(state, (s, round) => ({
    ...s,
    trustlines: s.trustlines.slice(
      round.reduce((n, t) => n + (t.covers.includes("REMOVE_TRUSTLINES") ? 100 : 0), 0)
    ),
  }));
  expect(actual.count).toBe(2);
  expect(plan.estimatedTransactionCount).toBe(actual.count);
  expect(plan.transactions.map((t) => t.covers)).toEqual(actual.covers);
});
