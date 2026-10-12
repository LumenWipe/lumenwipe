import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Account, Keypair, TransactionBuilder, Networks } from "@stellar/stellar-sdk";
import type { AccountState, ClaimableBalance, DecisionAnswer } from "@lumenwipe/types";
import { CLAIMABLE_BALANCE_READ_CEILING, CLAIM_ROUND_BATCH_SIZE } from "@/config/constants";
import { fetchClaimableBalancesForClaimant } from "@/lib/stellar/horizon-adapter";
import {
  BULK_FORFEIT_DECISION_ID,
  deriveBulkClaimDecisionPoints,
  resolveClaimSelections,
} from "@/lib/close-api/decisions";
import { buildPlan } from "@/lib/stellar/tx-builder";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";
import { stubIssuance } from "./fixtures/issuance";
import * as rpcModule from "@/lib/stellar/rpc";

beforeEach(() => stubIssuance());
afterEach(() => mock.restore());

const SOURCE = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const NOW = 1_800_000_000;
const BASE = "https://horizon.example";

function balance(
  n: number,
  predicate: ClaimableBalance["claimants"][number]["predicate"] = { type: "unconditional" },
  asset = "native"
): ClaimableBalance {
  return {
    id: `00000000${n.toString(16).padStart(64, "0")}`,
    asset,
    amount: "1.0000000",
    claimants: [{ destination: SOURCE, predicate }],
    sponsor: null,
  };
}

const expired = (n: number): ClaimableBalance =>
  balance(n, { type: "before_absolute_time", absBeforeEpoch: String(NOW - 10) });

function state(balances: ClaimableBalance[], over: Partial<AccountState> = {}): AccountState {
  return {
    address: SOURCE,
    network: "testnet",
    sequence: "100",
    nativeBalanceLumens: "500.0000000",
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
    claimableBalances: balances,
    subEntryMismatch: false,
    sponsoredEntries: [],
    sponsorshipEnumerationIncomplete: false,
    defiPositions: emptyDefiPositionsResult(SOURCE),
    defiPositionsWarnings: [],
    ledgerCloseTime: NOW,
    ...over,
  };
}

function horizonWith(total: number) {
  const record = (i: number) => ({
    id: `00000000${i.toString(16).padStart(64, "0")}`,
    asset: "native",
    amount: "1.0000000",
    last_modified_time: "2026-01-01T00:00:00Z",
    claimants: [{ destination: SOURCE, predicate: { unconditional: true } }],
  });
  const fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const limit = Number(url.searchParams.get("limit"));
    const cursor = Number(url.searchParams.get("cursor") ?? 0);
    const records = Array.from({ length: Math.max(0, Math.min(limit, total - cursor)) }, (_, i) =>
      record(cursor + i)
    );
    const next = `${BASE}/claimable_balances?claimant=${SOURCE}&limit=${limit}&cursor=${cursor + records.length}`;
    return new Response(
      JSON.stringify({ _embedded: { records }, _links: { next: { href: next } } }),
      { status: 200 }
    );
  }) as unknown as typeof globalThis.fetch;
  return { baseUrl: BASE, fetch };
}

test("a read past the ceiling returns a bounded part and says more exist instead of refusing", async () => {
  const read = await fetchClaimableBalancesForClaimant(
    SOURCE,
    horizonWith(CLAIMABLE_BALANCE_READ_CEILING + 1)
  );
  expect(read.balances).toHaveLength(CLAIMABLE_BALANCE_READ_CEILING);
  expect(read.more).toBe(true);
});

test("a collection that fits the ceiling exactly still reads as complete", async () => {
  const read = await fetchClaimableBalancesForClaimant(
    SOURCE,
    horizonWith(CLAIMABLE_BALANCE_READ_CEILING)
  );
  expect(read.balances).toHaveLength(CLAIMABLE_BALANCE_READ_CEILING);
  expect(read.more).toBe(false);
});

function rpcStub() {
  return {
    getAccount: () => Promise.resolve(new Account(SOURCE, "100")),
    getLatestLedger: () => Promise.resolve({ sequence: 1000, closeTime: String(NOW) }),
    getLedgerEntries: () => Promise.reject(new Error("unavailable")),
  };
}

function opTypes(xdrs: string[]): string[] {
  return xdrs.flatMap((x) =>
    TransactionBuilder.fromXDR(x, Networks.TESTNET).operations.map((o) => o.type)
  );
}

async function build(s: AccountState, selections: Record<string, "claim" | "forfeit"> = {}) {
  spyOn(rpcModule, "getRpcServer").mockImplementation((() =>
    rpcStub()) as unknown as typeof rpcModule.getRpcServer);
  const { buildCloseTransactions } = await import("@/lib/close-api/build-transactions");
  return buildCloseTransactions(s, DEST, {}, "testnet", null, selections);
}

const claims = (xdrs: string[]) => opTypes(xdrs).filter((t) => t === "claimClaimableBalance");

test("a claim round handles a bounded batch and requires another call until the list is exhausted", async () => {
  const all = Array.from({ length: CLAIM_ROUND_BATCH_SIZE * 2 + 50 }, (_, i) => balance(i));

  const first = await build(state(all));
  expect(claims(first.transactions.map((t) => t.xdr))).toHaveLength(CLAIM_ROUND_BATCH_SIZE);
  expect(first.requiresAnotherCall).toBe(true);

  const second = await build(state(all.slice(CLAIM_ROUND_BATCH_SIZE)));
  expect(claims(second.transactions.map((t) => t.xdr))).toHaveLength(CLAIM_ROUND_BATCH_SIZE);
  expect(second.requiresAnotherCall).toBe(true);

  const third = await build(state(all.slice(CLAIM_ROUND_BATCH_SIZE * 2)));
  expect(claims(third.transactions.map((t) => t.xdr))).toHaveLength(50);
  expect(third.requiresAnotherCall).toBe(true);

  const last = await build(state([]));
  expect(opTypes(last.transactions.map((t) => t.xdr))).toContain("accountMerge");
});

test("an interrupted run resumes by calling again and gets the same batch", async () => {
  const all = Array.from({ length: CLAIM_ROUND_BATCH_SIZE + 5 }, (_, i) => balance(i));
  const a = await build(state(all));
  const b = await build(state(all));
  expect(a.transactions.map((t) => t.xdr)).toEqual(b.transactions.map((t) => t.xdr));
});

test("the batch boundary: exactly one batch claims in one round, one more needs a second", async () => {
  const exact = Array.from({ length: CLAIM_ROUND_BATCH_SIZE }, (_, i) => balance(i));
  const r = await build(state(exact));
  expect(claims(r.transactions.map((t) => t.xdr))).toHaveLength(CLAIM_ROUND_BATCH_SIZE);
  const over = await build(state([...exact, balance(999)]));
  expect(claims(over.transactions.map((t) => t.xdr))).toHaveLength(CLAIM_ROUND_BATCH_SIZE);
});

test("the merge is never built while more balances exist than the read returned", async () => {
  const some = Array.from({ length: 3 }, (_, i) => balance(i));
  const r = await build(state(some, { claimableBalancesMore: true }));
  expect(r.requiresAnotherCall).toBe(true);
  expect(opTypes(r.transactions.map((t) => t.xdr))).not.toContain("accountMerge");
});

test("a read full of left-behind balances is a blocker, not a loop and not a merge", async () => {
  const forfeited = Array.from({ length: 5 }, (_, i) => balance(i));
  const answers = Object.fromEntries(forfeited.map((b) => [b.id, "forfeit" as const]));
  await expect(
    build(state(forfeited, { claimableBalancesMore: true }), answers)
  ).rejects.toMatchObject({ code: "claimable_balances_too_many" });
  await expect(build(state([], { claimableBalancesMore: true }))).rejects.toMatchObject({
    code: "claimable_balances_too_many",
  });
});

test("the plan reports the same blocker when nothing visible can be claimed", () => {
  const forfeited = [balance(1), balance(2)];
  const answers = Object.fromEntries(forfeited.map((b) => [b.id, "forfeit" as const]));
  const stuck = buildPlan(state(forfeited, { claimableBalancesMore: true }), false, false, answers);
  expect(stuck.blockers.map((b) => b.code)).toContain("claimable_balances_too_many");
  const moving = buildPlan(state(forfeited, { claimableBalancesMore: true }), false);
  expect(moving.blockers.map((b) => b.code)).not.toContain("claimable_balances_too_many");
});

const bulk: DecisionAnswer = { id: BULK_FORFEIT_DECISION_ID, choice: "forfeit_unclaimable" };

test("the bulk forfeit applies to every balance that is not claimable now", () => {
  const s = state([expired(1), expired(2), balance(3, { type: "unconditional" }, "USDC:GX")]);
  const sel = resolveClaimSelections([bulk], s);
  expect(sel[expired(1).id]).toBe("forfeit");
  expect(sel[expired(2).id]).toBe("forfeit");
  expect(sel[balance(3).id]).toBe("forfeit");
});

test("the bulk forfeit never touches a balance that is claimable now", () => {
  const s = state([expired(1), expired(2), balance(3)]);
  const sel = resolveClaimSelections([bulk], s);
  expect(sel[balance(3).id]).toBeUndefined();
});

test("an explicit per-balance answer wins over the bulk forfeit", () => {
  const s = state([expired(1), expired(2)]);
  const sel = resolveClaimSelections(
    [bulk, { id: `claim:${expired(1).id}`, choice: "add_trustline_then_claim" }],
    s
  );
  expect(sel[expired(1).id]).toBe("add_trustline_then_claim");
  expect(sel[expired(2).id]).toBe("forfeit");
});

test("without the bulk answer nothing is resolved for the caller", () => {
  expect(resolveClaimSelections([], state([expired(1), expired(2)]))).toEqual({});
});

test("the bulk decision is offered only when two or more balances cannot be claimed now, and is optional", () => {
  expect(deriveBulkClaimDecisionPoints(state([expired(1), balance(2)]))).toEqual([]);
  const [d] = deriveBulkClaimDecisionPoints(state([expired(1), expired(2), balance(3)]));
  expect(d!.id).toBe(BULK_FORFEIT_DECISION_ID);
  expect(d!.required).toBe(false);
  expect(d!.subject.count).toBe(2);
});

test("the bulk forfeit is neither offered nor applied while the ledger time is unknown", () => {
  const s = state([expired(1), expired(2), expired(3)], { ledgerCloseTime: undefined });
  expect(deriveBulkClaimDecisionPoints(s)).toEqual([]);
  expect(resolveClaimSelections([bulk], s)).toEqual({});
});
