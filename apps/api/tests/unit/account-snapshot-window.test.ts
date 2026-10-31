import { expect, test } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import { MAX_SNAPSHOT_LEDGER_SPAN, readAccountStateFrom } from "@/lib/stellar/account-state";
import { AccountStateChangedError } from "@/lib/utils/errors";
import type { ResolveDefiPositionsDeps } from "@/lib/defi-positions/resolve-defi-positions";
import { OFFLINE_SOROBAN_TOKENS } from "./fixtures/fake-soroban-tokens";

const BASE = "https://horizon.example";
const ADDRESS = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const NO_DEFI: ResolveDefiPositionsDeps = {
  octopos: { baseUrl: "" },
  directRead: { registryEntries: [] },
};
const PAGE = 200;

function offer(id: number) {
  return {
    id: String(id),
    selling: { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: ISSUER },
    buying: { asset_type: "native" },
    amount: "1.0000000",
    price: "1.0000000",
  };
}

const account = {
  sequence: "42",
  subentry_count: PAGE + 1,
  thresholds: { low_threshold: 0, med_threshold: 1, high_threshold: 1 },
  signers: [{ key: ADDRESS, weight: 1, type: "ed25519_public_key" }],
  balances: [{ asset_type: "native", balance: "100.0000000" }],
  data: {},
  flags: { auth_immutable: false },
  num_sponsoring: 0,
};

/** Answers the account, a two-page offer collection and an empty claimable-balance list, each
 *  stamped with the ledger `ledgerFor` gives that request; `null` sends no ledger header. */
function provider(ledgerFor: (url: string, call: number) => number | null) {
  const calls: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    const body = url.includes("cursor=page2")
      ? { _embedded: { records: [offer(PAGE + 1)] } }
      : url.includes("/offers")
        ? {
            _embedded: { records: Array.from({ length: PAGE }, (_, i) => offer(i + 1)) },
            _links: { next: { href: `${BASE}/accounts/${ADDRESS}/offers?limit=200&cursor=page2` } },
          }
        : url.includes("/claimable_balances")
          ? { _embedded: { records: [] } }
          : account;
    const ledger = ledgerFor(url, calls.length);
    const headers = ledger === null ? undefined : { "Latest-Ledger": String(ledger) };
    return new Response(JSON.stringify(body), { status: 200, headers });
  }) as unknown as typeof globalThis.fetch;
  return { deps: { baseUrl: BASE, fetch }, calls };
}

const read = (deps: { baseUrl: string; fetch: typeof globalThis.fetch }) =>
  readAccountStateFrom(ADDRESS, "testnet", deps, NO_DEFI, OFFLINE_SOROBAN_TOKENS);

test("the allowed span is two ledgers", () => {
  expect(MAX_SNAPSHOT_LEDGER_SPAN).toBe(2);
});

test("reads on one ledger report it as the snapshot ledger, with no second read", async () => {
  const { deps, calls } = provider(() => 500);
  const state = await read(deps);
  expect(state.snapshotLedger).toBe(500);
  expect(state.openOffers).toHaveLength(PAGE + 1);
  expect(calls).toHaveLength(4);
});

test("reads spread over exactly the allowed span are accepted", async () => {
  const { deps, calls } = provider((url) =>
    url.includes("cursor=page2") ? 500 + MAX_SNAPSHOT_LEDGER_SPAN : 500
  );
  const state = await read(deps);
  expect(state.snapshotLedger).toBe(500 + MAX_SNAPSHOT_LEDGER_SPAN);
  expect(calls).toHaveLength(4);
});

test("an offer page from a later ledger re-reads once and keeps the settled read", async () => {
  const { deps, calls } = provider((url, call) =>
    call <= 4 && url.includes("cursor=page2") ? 500 + MAX_SNAPSHOT_LEDGER_SPAN + 1 : 510
  );
  const state = await read(deps);
  expect(calls).toHaveLength(8);
  expect(state.snapshotLedger).toBe(510);
});

test("reads that still span too many ledgers on the second try are refused as a changed account", async () => {
  const { deps, calls } = provider((url, call) =>
    url.includes("cursor=page2") ? 600 + call : 600
  );
  await expect(read(deps)).rejects.toBeInstanceOf(AccountStateChangedError);
  expect(calls).toHaveLength(8);
});

test("a provider that reports no ledger leaves the snapshot ledger unset and reads once", async () => {
  const { deps, calls } = provider(() => null);
  const state = await read(deps);
  expect(state.snapshotLedger).toBeUndefined();
  expect(calls).toHaveLength(4);
});
