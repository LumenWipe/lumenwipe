/**
 * Adversarial coverage: revoked trustlines and clawback-adjacent state
 * (docs/architecture.md §17, issues #167 and #441).
 *
 * (a) close/transactions refuses a deauthorized or maintain-liabilities line holding a balance
 * before any live read; (b) a provider response whose authorization state cannot be read fails
 * the read instead of reading as authorized; (c) a clawback-enabled line is reported as such.
 */
import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as rpcModule from "@/lib/stellar/rpc";
import { Keypair } from "@stellar/stellar-sdk";
import { readAccountStateFrom } from "@/lib/stellar/account-state";
import { OFFLINE_SOROBAN_TOKENS } from "../unit/fixtures/fake-soroban-tokens";
import { buildCloseTransactions, CloseBuildError } from "@/lib/close-api/build-transactions";
import { buildPlan } from "@/lib/stellar/tx-builder";
import { UnusableProviderResponseError } from "@/lib/utils/errors";
import { mapDomainError, PLAN_ERRORS } from "@/lib/close-api/domain-errors";
import type { ResolveDefiPositionsDeps } from "@/lib/defi-positions/resolve-defi-positions";
import type { AccountState } from "@lumenwipe/types";
import { emptyDefiPositionsResult } from "../unit/fixtures/defi-positions";
import { authorizationOf } from "../unit/fixtures/trustline";

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

afterEach(() => {
  mock.restore();
});

// ─── (a) build-transactions.ts regression: the fix from this PR ─────────────────────────────

const REFUSED_STATES = [
  ["unauthorized", "trustline_deauthorized_with_balance"],
  ["maintain_liabilities", "trustline_maintain_liabilities_with_balance"],
] as const;

test.each(REFUSED_STATES)(
  "close/transactions refuses to build for a %s trustline holding a balance",
  async (authorization, code) => {
    spyOn(rpcModule, "getRpcServer").mockImplementation((() => ({
      getAccount: () => {
        throw new Error("should be refused before any live read");
      },
      getLatestLedger: () => {
        throw new Error("should be refused before any live read");
      },
    })) as unknown as typeof rpcModule.getRpcServer);

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
          ...authorizationOf(false),
          authorization,
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
    expect((err as CloseBuildError).code).toBe(code);
    expect((err as CloseBuildError).status).toBe(422);
  }
);

// ─── (b) a missing is_authorized field fails the read instead of reading as authorized ─────

const CREDIT_LINE = {
  asset_type: "credit_alphanum4",
  asset_code: "USDC",
  asset_issuer: ISSUER,
  balance: "10.0000000",
  limit: "100",
  is_authorized: true,
  is_authorized_to_maintain_liabilities: true,
};

function readWith(balance: Record<string, unknown>) {
  return readAccountStateFrom(
    SOURCE,
    "testnet",
    { baseUrl: BASE, fetch: stubFetch(balance) },
    NO_DEFI,
    OFFLINE_SOROBAN_TOKENS
  );
}

test("a trustline balance record omitting is_authorized fails the read, never reads as authorized", async () => {
  const { is_authorized: _omit, ...withoutAuthField } = CREDIT_LINE; // eslint-disable-line @typescript-eslint/no-unused-vars
  const err = await readWith(withoutAuthField).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(UnusableProviderResponseError);
  expect((err as Error).message).toContain(".is_authorized");
  expect(mapDomainError(PLAN_ERRORS, err)?.code).toBe("provider_response_unusable");
});

test("a deauthorized line that omits is_authorized_to_maintain_liabilities fails the read", async () => {
  const { is_authorized_to_maintain_liabilities: _omit, ...partial } = CREDIT_LINE; // eslint-disable-line @typescript-eslint/no-unused-vars
  const err = await readWith({ ...partial, is_authorized: false }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(UnusableProviderResponseError);
  expect((err as Error).message).toContain("is_authorized_to_maintain_liabilities");
});

test("a non-boolean is_clawback_enabled fails the read", async () => {
  const err = await readWith({ ...CREDIT_LINE, is_clawback_enabled: "yes" }).catch(
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(UnusableProviderResponseError);
});

// ─── (c) clawback-enabled trustlines are reported as such ───────────────────────────────────

test("a clawback-enabled trustline is reported as clawback-enabled and does not block the plan", async () => {
  const withState = await readWith({ ...CREDIT_LINE, is_clawback_enabled: true });
  const omittedState = await readWith(CREDIT_LINE);
  const falseState = await readWith({ ...CREDIT_LINE, is_clawback_enabled: false });

  expect(withState.trustlines[0]!.clawbackEnabled).toBe(true);
  expect(omittedState.trustlines[0]!.clawbackEnabled).toBe(false);
  expect(falseState.trustlines[0]!.clawbackEnabled).toBe(false);

  const withPlan = buildPlan(withState, false, false);
  const withoutPlan = buildPlan(omittedState, false, false);
  expect(withPlan.blockers).toEqual(withoutPlan.blockers);
  expect(withPlan.steps.map((s) => s.title)).toEqual(withoutPlan.steps.map((s) => s.title));
});

test("the three authorization states are told apart", async () => {
  const states = await Promise.all([
    readWith(CREDIT_LINE),
    readWith({ ...CREDIT_LINE, is_authorized: false }),
    readWith({
      ...CREDIT_LINE,
      is_authorized: false,
      is_authorized_to_maintain_liabilities: false,
    }),
  ]);
  expect(states.map((s) => s.trustlines[0]!.authorization)).toEqual([
    "authorized",
    "maintain_liabilities",
    "unauthorized",
  ]);
  expect(states.map((s) => s.trustlines[0]!.authorized)).toEqual([true, false, false]);
});
