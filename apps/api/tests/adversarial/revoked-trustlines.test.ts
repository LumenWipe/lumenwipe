/**
 * Adversarial coverage: revoked trustlines and clawback-adjacent state
 * (docs/architecture.md §17, issue #167).
 *
 * buildPlan.test.ts already has solid boundary coverage of the deauthorized-with-balance blocker
 * itself. This file targets the three gaps research for #167 found: (a) build-transactions.ts
 * never re-checked that same blocker before this PR's fix - regression-tested here; (b) a
 * provider response omitting `is_authorized` entirely silently defaults to "authorized"; (c) a
 * clawback-enabled trustline is not specially handled anywhere in this codebase today, so a
 * balance the issuer can claw back at any time - including between analysis and signing - gets no
 * warning at all. (c) is documented, not fixed: adding clawback awareness is new product scope
 * beyond this issue's "verify, don't invent" mandate, but the gap needs to be visible and
 * pinned down by a test that goes red the moment someone assumes otherwise.
 */
import { test, expect, mock, afterEach } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import { readAccountStateFrom } from "@/lib/stellar/account-state";
import { buildCloseTransactions, CloseBuildError } from "@/lib/close-api/build-transactions";
import { buildPlan } from "@/lib/stellar/tx-builder";
import type { ResolveDefiPositionsDeps } from "@/lib/defi-positions/resolve-defi-positions";
import type { AccountState } from "@lumenwipe/types";
import { emptyDefiPositionsResult } from "../unit/fixtures/defi-positions";

const SOURCE = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const BASE = "https://horizon.example";

const NO_DEFI: ResolveDefiPositionsDeps = {
  octopos: { baseUrl: "" },
  directRead: { registryEntries: [] },
};

function accountBody(balance: Record<string, unknown>) {
  return {
    sequence: "42",
    subentry_count: 1,
    thresholds: { low_threshold: 0, med_threshold: 1, high_threshold: 1 },
    signers: [{ key: SOURCE, weight: 1, type: "ed25519_public_key" }],
    balances: [{ asset_type: "native", balance: "100.0000000" }, balance],
    data: {},
    flags: { auth_immutable: false },
    num_sponsoring: 0,
  };
}

function stubFetch(balance: Record<string, unknown>) {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    const body =
      url.includes("/offers") || url.includes("/claimable_balances")
        ? { _embedded: { records: [] } }
        : accountBody(balance);
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
}

const realRpc = await import("@/lib/stellar/rpc");
afterEach(() => {
  mock.module("@/lib/stellar/rpc", () => realRpc);
});

// ─── (a) build-transactions.ts regression: the fix from this PR ─────────────────────────────

test("close/transactions refuses to build for a deauthorized trustline holding a balance", async () => {
  mock.module("@/lib/stellar/rpc", () => ({
    getRpcServer: () => ({
      getAccount: () => {
        throw new Error("should be refused before any live read");
      },
      getLatestLedger: () => {
        throw new Error("should be refused before any live read");
      },
    }),
  }));

  const accountState: AccountState = {
    address: SOURCE,
    network: "testnet",
    sequence: "100",
    nativeBalanceLumens: "5.0000000",
    dataEntries: [],
    signers: [{ key: SOURCE, weight: 1, type: "ed25519_public_key" }],
    thresholds: { low: 0, med: 1, high: 1 },
    numSubEntries: 1,
    numSponsoring: 0,
    sponsoredBy: null,
    authImmutable: false,
    trustlines: [
      {
        asset: `USDC:${ISSUER}`,
        balance: "50.0000000",
        authorized: false,
        issuer: ISSUER,
        code: "USDC",
        limit: "1000",
      },
    ],
    openOffers: [],
    poolShares: [],
    claimableBalances: [],
    subEntryMismatch: false,
    sponsoredEntries: [],
    sponsorshipEnumerationIncomplete: false,
    defiPositions: emptyDefiPositionsResult(SOURCE),
    defiPositionsWarnings: [],
  };

  const err = await buildCloseTransactions(accountState, DEST, {}, "testnet").catch(
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(CloseBuildError);
  expect((err as CloseBuildError).code).toBe("trustline_deauthorized_with_balance");
  expect((err as CloseBuildError).status).toBe(422);
});

// ─── (b) a missing is_authorized field silently defaults to "authorized" ────────────────────

test("a trustline balance record omitting is_authorized reads as authorized, not unknown", async () => {
  const { is_authorized: _omit, ...balanceWithoutAuthField } = {
    asset_type: "credit_alphanum4",
    asset_code: "USDC",
    asset_issuer: ISSUER,
    balance: "10.0000000",
    limit: "100",
    is_authorized: true,
  };
  const state = await readAccountStateFrom(
    SOURCE,
    "testnet",
    { baseUrl: BASE, fetch: stubFetch(balanceWithoutAuthField) },
    NO_DEFI
  );
  // Documents the current `?? true` default in account-state.ts - if a real provider ever
  // omits this field for a trustline that is actually deauthorized, this default would silently
  // misclassify it as safe to convert. Horizon itself always includes the field for a trustline
  // balance, so this is a defensive default rather than an observed provider gap - but the
  // default itself is what this test pins down.
  expect(state.trustlines[0]!.authorized).toBe(true);
});

// ─── (c) clawback-enabled trustlines are not specially handled anywhere today ───────────────

test("a clawback-enabled trustline is treated identically to a non-clawback one - no warning exists today", async () => {
  const withClawback = {
    asset_type: "credit_alphanum4",
    asset_code: "USDC",
    asset_issuer: ISSUER,
    balance: "10.0000000",
    limit: "100",
    is_authorized: true,
    is_clawback_enabled: true,
  };
  const withoutClawback = { ...withClawback, is_clawback_enabled: false };

  const withState = await readAccountStateFrom(
    SOURCE,
    "testnet",
    { baseUrl: BASE, fetch: stubFetch(withClawback) },
    NO_DEFI
  );
  const withoutState = await readAccountStateFrom(
    SOURCE,
    "testnet",
    { baseUrl: BASE, fetch: stubFetch(withoutClawback) },
    NO_DEFI
  );

  // Identical parsed trustlines: the clawback flag is dropped entirely during mapping, not
  // read anywhere. If this test ever starts failing because the two diverge, it means clawback
  // awareness has been added - update this test to assert the new (presumably protective)
  // behavior instead of deleting it.
  expect(withState.trustlines).toEqual(withoutState.trustlines);

  const withPlan = buildPlan(withState, false, false);
  const withoutPlan = buildPlan(withoutState, false, false);
  // No blocker, no distinct wording, no notice: a clawback-enabled balance the issuer could
  // reclaim between analysis and signing is planned exactly like any other convertible balance.
  expect(withPlan.blockers).toEqual(withoutPlan.blockers);
  expect(withPlan.steps.map((s) => s.title)).toEqual(withoutPlan.steps.map((s) => s.title));
});
