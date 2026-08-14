import { test, expect } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import { readAccountStateFrom } from "@/lib/stellar/account-state";

// Every fixture below reports `num_sponsoring: 0`, which `enumerateSponsoredEntries` treats as
// a complete answer and returns without any I/O of its own. That keeps these tests measuring
// the account-state read alone without a module mock - `mock.module` is process-global in Bun
// and would leak this stub into every other suite in the same run.

const BASE = "https://horizon.example";
const ADDRESS = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();

function trustlineBalance(code: string) {
  return {
    asset_type: "credit_alphanum4",
    asset_code: code,
    asset_issuer: ISSUER,
    balance: "10.0000000",
    limit: "100",
    is_authorized: true,
  };
}

function accountBody(overrides: Record<string, unknown> = {}) {
  return {
    sequence: "42",
    subentry_count: 0,
    thresholds: { low_threshold: 0, med_threshold: 1, high_threshold: 1 },
    signers: [{ key: ADDRESS, weight: 1, type: "ed25519_public_key" }],
    balances: [{ asset_type: "native", balance: "100.0000000" }],
    data: {},
    flags: { auth_immutable: false },
    num_sponsoring: 0,
    ...overrides,
  };
}

function stubProvider(account: Record<string, unknown>) {
  const calls: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    const body = url.includes("/offers")
      ? { _embedded: { records: [] } }
      : url.includes("/claimable_balances")
        ? { _embedded: { records: [] } }
        : account;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { deps: { baseUrl: BASE, fetch }, calls };
}

// The regression this refactor exists to prevent. The previous implementation enumerated asset
// codes from an indexer that carried no balances, then issued one RPC read per trustline, so a
// single inbound request fanned out to hundreds of upstream calls. The count must not depend on
// how much the account holds.
test("one account read makes a constant number of upstream calls, whatever the account holds", async () => {
  const empty = stubProvider(accountBody());
  await readAccountStateFrom(ADDRESS, "testnet", empty.deps);
  expect(empty.calls).toHaveLength(3); // account, offers, claimable balances

  const codes = Array.from({ length: 40 }, (_, i) => `AST${i}`);
  const heavy = stubProvider(
    accountBody({
      subentry_count: 40,
      balances: [{ asset_type: "native", balance: "100.0000000" }, ...codes.map(trustlineBalance)],
    })
  );
  const state = await readAccountStateFrom(ADDRESS, "testnet", heavy.deps);

  expect(state.trustlines).toHaveLength(40);
  expect(heavy.calls).toHaveLength(3);
});

test("balances, data entries, signers and thresholds all come from the single account call", async () => {
  const { deps, calls } = stubProvider(
    accountBody({
      subentry_count: 2,
      balances: [{ asset_type: "native", balance: "5.0000000" }, trustlineBalance("USDC")],
      data: { "lw-key": "dmFsdWU=" },
      thresholds: { low_threshold: 1, med_threshold: 2, high_threshold: 3 },
    })
  );
  const state = await readAccountStateFrom(ADDRESS, "testnet", deps);

  expect(state.nativeBalanceLumens).toBe("5.0000000");
  expect(state.trustlines.map((t) => t.code)).toEqual(["USDC"]);
  expect(state.dataEntries).toEqual([{ key: "lw-key", value: "dmFsdWU=" }]);
  expect(state.thresholds).toEqual({ low: 1, med: 2, high: 3 });
  expect(calls.filter((c) => c.includes("/accounts/") && !c.includes("/offers"))).toHaveLength(1);
});

// Ground truth for completeness. Enumerating fewer entries than the ledger reports means the
// plan would leave entries behind and the merge would fail with op_has_sub_entries, so this has
// to surface rather than produce a quietly short plan. There is no second path to confirm it
// against any more - the mismatch is the answer.
test("enumerating fewer entries than the ledger reports surfaces a sub-entry mismatch", async () => {
  const { deps } = stubProvider(
    accountBody({
      subentry_count: 5,
      balances: [{ asset_type: "native", balance: "5.0000000" }, trustlineBalance("USDC")],
    })
  );
  const state = await readAccountStateFrom(ADDRESS, "testnet", deps);
  expect(state.subEntryMismatch).toBe(true);
});

test("a fully enumerated account reports no mismatch", async () => {
  const { deps } = stubProvider(
    accountBody({
      subentry_count: 1,
      balances: [{ asset_type: "native", balance: "5.0000000" }, trustlineBalance("USDC")],
    })
  );
  const state = await readAccountStateFrom(ADDRESS, "testnet", deps);
  expect(state.subEntryMismatch).toBe(false);
});

test("a missing account is not found rather than an empty state", async () => {
  const fetch = (async () =>
    new Response("", { status: 404 })) as unknown as typeof globalThis.fetch;
  await expect(readAccountStateFrom(ADDRESS, "testnet", { baseUrl: BASE, fetch })).rejects.toThrow(
    /does not exist on this network/i
  );
});

// Pointing at a different Horizon-compatible host is configuration, not code. This is the
// "pluggable provider" property, asserted at the only place it can be: the requests themselves.
//
// Scope, stated so this is not read as more than it is: this covers the account-state read.
// `enumerateSponsoredEntries` still resolves its own base from PATH_ROUTING_API_URLS rather
// than taking these deps, so an account that sponsors entries has part of its state read
// outside this seam. That path is unaffected by `baseUrl` here, and its 429s do not reach
// `rateLimitHits()`. Every fixture uses `num_sponsoring: 0`, which short-circuits it - so this
// test would pass either way, and says nothing about that path.
test("every account-state request goes to the configured provider", async () => {
  const other = "https://horizon.other-provider.example";
  const calls: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    const body =
      url.includes("/offers") || url.includes("/claimable_balances")
        ? { _embedded: { records: [] } }
        : accountBody();
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof globalThis.fetch;

  await readAccountStateFrom(ADDRESS, "testnet", { baseUrl: other, fetch });
  expect(calls).toHaveLength(3);
  expect(calls.every((c) => c.startsWith(other))).toBe(true);
});
