import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Account, Keypair, TransactionBuilder, Networks } from "@stellar/stellar-sdk";
import type { AccountState, ClaimableBalance, ClaimPredicate } from "@lumenwipe/types";
import { CLAIM_PREDICATE_MARGIN_SECONDS } from "@/config/constants";
import {
  claimStatus,
  claimableFromEpoch,
  isCurrentlyClaimable,
  predicateHoldsThroughWindow,
} from "@/lib/stellar/claim-predicates";
import { deriveClaimableBalanceDecisionPoints } from "@/lib/close-api/decisions";
import { buildPlan } from "@/lib/stellar/tx-builder";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";
import { stubIssuance } from "./fixtures/issuance";
import { stubLedgerConfirmation } from "./fixtures/ledger-confirmation";
import * as rpcModule from "@/lib/stellar/rpc";

beforeEach(() => {
  stubIssuance();
  stubLedgerConfirmation();
  stubLedgerConfirmation();
});
afterEach(() => mock.restore());

const SOURCE = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const NOW = 1_800_000_000;
const MARGIN = CLAIM_PREDICATE_MARGIN_SECONDS;

const before = (epoch: number): ClaimPredicate => ({
  type: "before_absolute_time",
  absBeforeEpoch: String(epoch),
});
const notBefore = (epoch: number): ClaimPredicate => ({ type: "not", predicate: before(epoch) });

function balance(hex: string, predicate: ClaimPredicate, asset = "native"): ClaimableBalance {
  return {
    id: `00000000${hex.repeat(64)}`,
    asset,
    amount: "10.0000000",
    claimants: [{ destination: SOURCE, predicate }],
    sponsor: null,
  };
}

function state(balances: ClaimableBalance[], over: Partial<AccountState> = {}): AccountState {
  return {
    address: SOURCE,
    network: "testnet",
    sequence: "100",
    nativeBalanceLumens: "50.0000000",
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

test("predicate window › expired abs_before, future not(before) and rel_before are not claimable", () => {
  expect(predicateHoldsThroughWindow(before(NOW - 1), NOW)).toBe(false);
  expect(predicateHoldsThroughWindow(notBefore(NOW + 3600), NOW)).toBe(false);
  expect(
    predicateHoldsThroughWindow(
      { type: "before_relative_time", relBeforeSeconds: "60", deadlineEpoch: String(NOW - 5) },
      NOW
    )
  ).toBe(false);
});

test("predicate window › a balance about to expire inside the margin is excluded", () => {
  expect(predicateHoldsThroughWindow(before(NOW + MARGIN - 1), NOW)).toBe(false);
  expect(predicateHoldsThroughWindow(before(NOW + MARGIN + 1), NOW)).toBe(true);
});

test("predicate window › unknown ledger time only trusts an unconditional predicate", () => {
  expect(predicateHoldsThroughWindow({ type: "unconditional" }, undefined)).toBe(true);
  expect(predicateHoldsThroughWindow(before(NOW + 100_000), undefined)).toBe(false);
  expect(predicateHoldsThroughWindow({ type: "unconditional" }, null)).toBe(true);
});

test("claimableFromEpoch › names the date a vesting balance opens, null when it never will", () => {
  expect(claimableFromEpoch(notBefore(NOW + 3600), NOW)).toBe(NOW + 3600);
  expect(claimableFromEpoch(before(NOW - 10), NOW)).toBeNull();
  const window: ClaimPredicate = {
    type: "and",
    predicates: [notBefore(NOW + 100), before(NOW + 1000)],
  };
  expect(claimableFromEpoch(window, NOW)).toBe(NOW + 100);
});

test("claimStatus › a closed predicate wins over a missing trustline; no own claimant is blocked", () => {
  const s = state([]);
  expect(claimStatus(balance("a", before(NOW - 1), "USDC:GX"), s, NOW)).toBe("predicate_blocked");
  expect(claimStatus(balance("b", { type: "unconditional" }, "USDC:GX"), s, NOW)).toBe(
    "needs_trustline"
  );
  const stranger: ClaimableBalance = {
    ...balance("c", { type: "unconditional" }),
    claimants: [{ destination: DEST, predicate: { type: "unconditional" } }],
  };
  expect(isCurrentlyClaimable(stranger, s, NOW)).toBe(false);
});

test("decisions › an expired balance offers only forfeit with no default and says it is closed", () => {
  const [d] = deriveClaimableBalanceDecisionPoints(state([balance("a", before(NOW - 1))]));
  expect(d!.options.map((o) => o.id)).toEqual(["forfeit"]);
  expect(d!.default).toBe("");
  expect(d!.options[0]!.note).toContain("can no longer be claimed");
});

test("decisions › a vesting balance states the date it becomes claimable", () => {
  const opens = Date.UTC(2027, 0, 15, 12, 30) / 1000;
  const [d] = deriveClaimableBalanceDecisionPoints(
    state([balance("a", notBefore(opens))], { ledgerCloseTime: opens - 86_400 })
  );
  expect(d!.options.map((o) => o.id)).toEqual(["forfeit"]);
  expect(d!.options[0]!.note).toContain("2027-01-15 12:30 UTC");
  expect(d!.subject.claimableFromEpoch).toBe(opens);
});

test("buildPlan › an expired balance blocks with its own message and is not claimed by default", () => {
  const s = state([balance("a", before(NOW - 1))]);
  const plan = buildPlan(s, false);
  expect(plan.blockers.map((b) => b.code)).toContain("claimable_balance_unclaimable");
  expect(plan.blockers[0]!.message).toContain("can no longer be claimed");
  expect(plan.steps.some((st) => st.type === "CLAIM_BALANCES")).toBe(false);
});

test("buildPlan › forfeiting the expired balance leaves only the acknowledged warning", () => {
  const b = balance("a", before(NOW - 1));
  const plan = buildPlan(state([b]), false, false, { [b.id]: "forfeit" });
  expect(plan.blockers.map((x) => x.code)).toEqual(["claimable_balance_forfeited"]);
});

test("buildPlan › unknown ledger time fails closed for a time-bound balance", () => {
  const s = state([balance("a", before(NOW + 10_000_000))], { ledgerCloseTime: undefined });
  expect(buildPlan(s, false).blockers.map((b) => b.code)).toContain(
    "claimable_balance_unclaimable"
  );
});

function rpcStub(closeTime: number) {
  return {
    getAccount: () => Promise.resolve(new Account(SOURCE, "100")),
    getLatestLedger: () => Promise.resolve({ sequence: 1000, closeTime: String(closeTime) }),
    getLedgerEntries: () => Promise.reject(new Error("unavailable")),
  };
}

function claimIds(xdr: string): number {
  return TransactionBuilder.fromXDR(xdr, Networks.TESTNET).operations.filter(
    (o) => o.type === "claimClaimableBalance"
  ).length;
}

test("buildCloseTransactions › one expired and one good balance claim only the good one", async () => {
  spyOn(rpcModule, "getRpcServer").mockImplementation((() =>
    rpcStub(NOW)) as unknown as typeof rpcModule.getRpcServer);
  const { buildCloseTransactions } = await import("@/lib/close-api/build-transactions");
  const expired = balance("a", before(NOW - 1));
  const good = balance("b", { type: "unconditional" });
  const result = await buildCloseTransactions(state([expired, good]), DEST, {}, "testnet", null, {
    [expired.id]: "forfeit",
  });
  expect(result.requiresAnotherCall).toBe(true);
  expect(result.transactions).toHaveLength(1);
  expect(claimIds(result.transactions[0]!.xdr)).toBe(1);
});

test("buildCloseTransactions › an expired balance with no answer is refused, never merged around", async () => {
  spyOn(rpcModule, "getRpcServer").mockImplementation((() =>
    rpcStub(NOW)) as unknown as typeof rpcModule.getRpcServer);
  const { buildCloseTransactions } = await import("@/lib/close-api/build-transactions");
  await expect(
    buildCloseTransactions(state([balance("a", before(NOW - 1))]), DEST, {}, "testnet")
  ).rejects.toMatchObject({ code: "claimable_balance_not_claimable_now" });
});

test("buildCloseTransactions › a balance claimable at plan time that closed by build time is refused", async () => {
  spyOn(rpcModule, "getRpcServer").mockImplementation((() =>
    rpcStub(NOW + 300)) as unknown as typeof rpcModule.getRpcServer);
  const { buildCloseTransactions } = await import("@/lib/close-api/build-transactions");
  const flips = balance("a", before(NOW + 400));
  await expect(
    buildCloseTransactions(state([flips]), DEST, {}, "testnet", null, {})
  ).rejects.toMatchObject({ code: "claimable_balance_not_claimable_now" });
});

test("buildCloseTransactions › a claim answer for a balance that needs a trustline is refused", async () => {
  spyOn(rpcModule, "getRpcServer").mockImplementation((() =>
    rpcStub(NOW)) as unknown as typeof rpcModule.getRpcServer);
  const { buildCloseTransactions } = await import("@/lib/close-api/build-transactions");
  const needsTrustline = balance("a", { type: "unconditional" }, "USDC:GX");
  await expect(
    buildCloseTransactions(state([needsTrustline]), DEST, {}, "testnet", null, {
      [needsTrustline.id]: "claim",
    })
  ).rejects.toMatchObject({ code: "claimable_balance_not_claimable_now" });
});

test("buildCloseTransactions › an explicit forfeit of a closed balance still builds the merge", async () => {
  spyOn(rpcModule, "getRpcServer").mockImplementation((() =>
    rpcStub(NOW)) as unknown as typeof rpcModule.getRpcServer);
  const { buildCloseTransactions } = await import("@/lib/close-api/build-transactions");
  const closed = balance("a", before(NOW - 1));
  const result = await buildCloseTransactions(state([closed]), DEST, {}, "testnet", null, {
    [closed.id]: "forfeit",
  });
  const types = result.transactions.flatMap((t) =>
    TransactionBuilder.fromXDR(t.xdr, Networks.TESTNET).operations.map((o) => o.type)
  );
  expect(types).toContain("accountMerge");
  expect(types).not.toContain("claimClaimableBalance");
});

test("buildCloseTransactions › a stale claim answer for a balance now closed is refused, not skipped", async () => {
  spyOn(rpcModule, "getRpcServer").mockImplementation((() =>
    rpcStub(NOW)) as unknown as typeof rpcModule.getRpcServer);
  const { buildCloseTransactions } = await import("@/lib/close-api/build-transactions");
  const aboutToExpire = balance("a", before(NOW + 30));
  await expect(
    buildCloseTransactions(state([aboutToExpire]), DEST, {}, "testnet", null, {
      [aboutToExpire.id]: "claim",
    })
  ).rejects.toMatchObject({ code: "claimable_balance_not_claimable_now" });
});

const INT64_MAX = "9223372036854775807";

test("an absurdly distant opening date cannot break the plan or the decisions", () => {
  const far: ClaimPredicate = {
    type: "not",
    predicate: { type: "before_absolute_time", absBeforeEpoch: INT64_MAX },
  };
  const s = state([balance("a", far)]);
  expect(claimableFromEpoch(far, NOW)).toBeNull();
  const [d] = deriveClaimableBalanceDecisionPoints(s);
  expect(d!.options.map((o) => o.id)).toEqual(["forfeit"]);
  expect(d!.options[0]!.note).toContain("can no longer be claimed");
  expect(buildPlan(s, false).blockers.map((b) => b.code)).toContain(
    "claimable_balance_unclaimable"
  );
});

test.each([["NaN"], ["0"], ["-5"], [undefined]])(
  "buildCloseTransactions › an unusable ledger close time (%p) is unknown, so a time-bound balance is refused",
  async (closeTime) => {
    spyOn(rpcModule, "getRpcServer").mockImplementation((() => ({
      ...rpcStub(NOW),
      getLatestLedger: () => Promise.resolve({ sequence: 1000, closeTime }),
    })) as unknown as typeof rpcModule.getRpcServer);
    const { buildCloseTransactions } = await import("@/lib/close-api/build-transactions");
    await expect(
      buildCloseTransactions(state([balance("a", before(NOW + 100_000))]), DEST, {}, "testnet")
    ).rejects.toMatchObject({ code: "claimable_balance_not_claimable_now" });
  }
);
