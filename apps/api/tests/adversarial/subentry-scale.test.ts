/**
 * Adversarial coverage: the ~1000-subentry-scale account and the 100-operation batching limit
 * (docs/architecture.md §17 and §8, issue #167).
 *
 * Existing coverage (closeBatching.test.ts) proves multi-transaction sequence-chaining works
 * mechanically at 150 items, and horizon-http.test.ts proves the generic pagination helper
 * refuses a collection over its cap. Neither exercises the scale or combined-entry-kind
 * complexity the issue names: a real account near the practical ceiling for how many subentries
 * a single read can enumerate, with more than one hostile condition stacked at once, and the
 * account's own subentries (not just the generic pagination utility) hitting that ceiling.
 */
import { test, expect } from "bun:test";
import { Account, Keypair, StrKey, TransactionBuilder, Networks } from "@stellar/stellar-sdk";
import {
  assembleFusedCloseOpsTagged,
  type FusedCloseInput,
} from "@/lib/stellar/tx-builder/fused-close";
import { packFusedCloseTransactions } from "@/lib/close-api/build-transactions";
import { readAccountStateFrom } from "@/lib/stellar/account-state";
import { TruncatedCollectionError } from "@/lib/stellar/horizon-http";
import type { ResolveDefiPositionsDeps } from "@/lib/defi-positions/resolve-defi-positions";
import type { SponsoredEntry } from "@lumenwipe/types";

const MASTER = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const CO_SIGNER = StrKey.encodeSha256Hash(Keypair.random().rawPublicKey());
const OWNER = Keypair.random().publicKey();
const START_SEQ = "100";
const BASE = "https://horizon.example";

// Testnet always takes the direct-read path regardless of OctoPos config; an empty registry
// means zero network I/O - see account-state.test.ts's own NO_DEFI for the full rationale.
const NO_DEFI: ResolveDefiPositionsDeps = {
  octopos: { baseUrl: "" },
  directRead: { registryEntries: [] },
};

function manyTrustlines(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    asset: `AST${i}:${ISSUER}`,
    balance: "0",
    authorized: true,
    issuer: ISSUER,
    code: `AST${i}`,
  }));
}

function input(over: Partial<FusedCloseInput> = {}): FusedCloseInput {
  return {
    needsSignerNormalization: false,
    signers: [{ key: MASTER, weight: 1, type: "ed25519_public_key" }],
    revokeSponsorshipEntries: [],
    dataEntries: [],
    openOffers: [],
    claimableBalances: [],
    trustlinesToAddForClaim: [],
    assetActions: [],
    trustlines: [],
    destinationAddress: DEST,
    memo: null,
    memoType: null,
    includeMerge: true,
    ...over,
  };
}

function opCount(xdr: string): number {
  return TransactionBuilder.fromXDR(xdr, Networks.TESTNET).operations.length;
}

test("a near-1000-subentry account batches into sequence-chained transactions with no ops lost", () => {
  // 998 trustlines - close to the practical ceiling a single close can enumerate and still
  // fits comfortably under the pagination cap (1000) each individual entry-kind read uses.
  const in_ = input({ trustlines: manyTrustlines(998) });
  const total = assembleFusedCloseOpsTagged(MASTER, in_).length; // 998 removals + merge

  const txs = packFusedCloseTransactions(new Account(MASTER, START_SEQ), in_, "testnet", 999);

  expect(txs.length).toBe(10); // ceil(999 / 100)
  const counts = txs.map((t) => opCount(t.xdr));
  for (const c of counts) expect(c).toBeLessThanOrEqual(100);
  expect(counts.reduce((a, b) => a + b, 0)).toBe(total);

  const last = txs[txs.length - 1]!;
  expect(last.covers).toContain("MERGE");
  for (const t of txs.slice(0, -1)) expect(t.covers).not.toContain("MERGE");
});

test("stacked hostile state: near-max trustlines, signer normalization, and sponsorship revocation batch together correctly", () => {
  const revoke: SponsoredEntry[] = [{ kind: "trustline", owner: OWNER, asset: `USDX:${ISSUER}` }];
  const in_ = input({
    trustlines: manyTrustlines(300),
    needsSignerNormalization: true,
    signers: [
      { key: MASTER, weight: 1, type: "ed25519_public_key" },
      { key: CO_SIGNER, weight: 1, type: "hash_x" },
    ],
    revokeSponsorshipEntries: revoke,
  });
  const total = assembleFusedCloseOpsTagged(MASTER, in_).length;

  const txs = packFusedCloseTransactions(new Account(MASTER, START_SEQ), in_, "testnet", 999);

  const counts = txs.map((t) => opCount(t.xdr));
  for (const c of counts) expect(c).toBeLessThanOrEqual(100);
  expect(counts.reduce((a, b) => a + b, 0)).toBe(total);

  // Every op is still accounted for and correctly ordered even with three hostile conditions
  // stacked at once: sponsorship revocation and signer normalization both precede the trustline
  // removals, and the merge still lands only in the last transaction.
  expect(txs[0]!.covers).toEqual(
    expect.arrayContaining(["REVOKE_SPONSORSHIP", "NORMALIZE_SIGNERS"])
  );
  const last = txs[txs.length - 1]!;
  expect(last.covers).toContain("MERGE");
  for (const t of txs.slice(0, -1)) expect(t.covers).not.toContain("MERGE");
});

// A distinct failure mode from the batching tests above: this account's OWN open-offer count
// exceeds what a single Horizon-compatible read can enumerate at all, before any plan is even
// attempted. horizon-http.test.ts proves the generic pagination helper refuses this; this proves
// the real account-read path (readAccountStateFrom, called by both GET /account/:address and
// /close/plan) surfaces it as a typed, catchable error rather than a partial silent read.
test("an account whose own open-offer count exceeds the enumeration cap fails the read, not silently", async () => {
  const account = {
    sequence: "42",
    subentry_count: 1001,
    thresholds: { low_threshold: 0, med_threshold: 1, high_threshold: 1 },
    signers: [{ key: MASTER, weight: 1, type: "ed25519_public_key" }],
    balances: [{ asset_type: "native", balance: "100.0000000" }],
    data: {},
    flags: { auth_immutable: false },
    num_sponsoring: 0,
  };
  const oversizedOffers = Array.from({ length: 1001 }, (_, i) => ({
    id: i,
    selling: { asset_type: "native" },
    buying: { asset_type: "native" },
    amount: "1",
    price: "1",
  }));
  const fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/offers")) {
      return new Response(JSON.stringify({ _embedded: { records: oversizedOffers } }), {
        status: 200,
      });
    }
    if (url.includes("/claimable_balances")) {
      return new Response(JSON.stringify({ _embedded: { records: [] } }), { status: 200 });
    }
    return new Response(JSON.stringify(account), { status: 200 });
  }) as unknown as typeof globalThis.fetch;

  await expect(
    readAccountStateFrom(MASTER, "testnet", { baseUrl: BASE, fetch }, NO_DEFI)
  ).rejects.toBeInstanceOf(TruncatedCollectionError);
});
