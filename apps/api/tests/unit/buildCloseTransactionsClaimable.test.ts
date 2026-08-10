import { test, expect, mock, afterEach } from "bun:test";
import { Account, Keypair, TransactionBuilder, Networks } from "@stellar/stellar-sdk";
import type { AccountState, SponsoredEntry } from "@lumenwipe/types";

// Regression coverage for the real (money-moving) close builder honoring per-balance
// claimable-balance selections, not just the /close/plan preview (tx-builder/index.ts's
// buildPlan). Before this change, `buildCloseTransactions` claimed every reported claimable
// balance unconditionally, regardless of trustline authorization or user choice.
//
// Drives the real `buildCloseTransactions` with the RPC layer mocked, so no network access.

const SOURCE = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const USDC = `USDC:${ISSUER}`;

function accountState(over: Partial<AccountState> = {}): AccountState {
  return {
    address: SOURCE,
    network: "testnet",
    sequence: "100",
    nativeBalanceLumens: "5.0000000",
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
    ...over,
  };
}

function balanceId(hexChar: string) {
  return `00000000${hexChar.repeat(64)}`;
}

function claimableBalance(hexChar: string, asset: string, amount = "10.0000000") {
  return {
    id: balanceId(hexChar),
    asset,
    amount,
    claimants: [{ destination: SOURCE, predicate: { type: "unconditional" as const } }],
    sponsor: null,
  };
}

// getLedgerEntries is left unimplemented (rejects) so filterExistingClaimableBalances falls
// back to its documented "keep the full batch" behavior - the "still exists on-chain" filter
// is not what these tests are about.
function rpcServerStub() {
  return {
    getAccount: () => Promise.resolve(new Account(SOURCE, "100")),
    getLatestLedger: () => Promise.resolve({ sequence: 1000 }),
    getLedgerEntries: () => Promise.reject(new Error("not stubbed")),
  };
}

const realRpc = await import("@/lib/stellar/rpc");
const realSponsorshipAffordability = await import("@/lib/stellar/sponsorship-affordability");
afterEach(() => {
  mock.module("@/lib/stellar/rpc", () => realRpc);
  mock.module("@/lib/stellar/sponsorship-affordability", () => realSponsorshipAffordability);
});

function opsOf(xdr: string) {
  return TransactionBuilder.fromXDR(xdr, Networks.TESTNET).operations;
}

test("buildCloseTransactions › add_trustline_then_claim balance → changeTrust immediately precedes claimClaimableBalance", async () => {
  mock.module("@/lib/stellar/rpc", () => ({ getRpcServer: () => rpcServerStub() }));
  const { buildCloseTransactions } = await import("@/lib/close-api/build-transactions");

  const balance = claimableBalance("a", USDC);
  const state = accountState({ claimableBalances: [balance] });

  const result = await buildCloseTransactions(state, DEST, {}, "testnet", null, {
    [balance.id]: "add_trustline_then_claim",
  });

  expect(result.requiresAnotherCall).toBe(true);
  expect(result.transactions).toHaveLength(1);
  expect(result.transactions[0].covers).toContain("ADD_TRUSTLINE_FOR_CLAIM");
  expect(result.transactions[0].covers).toContain("CLAIM_BALANCES");

  const ops = opsOf(result.transactions[0].xdr);
  expect(ops).toHaveLength(2);
  expect(ops[0].type).toBe("changeTrust");
  expect(ops[1].type).toBe("claimClaimableBalance");
});

test("buildCloseTransactions › forfeited unclaimable balance → excluded from the claim round entirely", async () => {
  mock.module("@/lib/stellar/rpc", () => ({ getRpcServer: () => rpcServerStub() }));
  const { buildCloseTransactions } = await import("@/lib/close-api/build-transactions");

  const balance = claimableBalance("b", USDC);
  const state = accountState({ claimableBalances: [balance] });

  const result = await buildCloseTransactions(state, DEST, {}, "testnet", null, {
    [balance.id]: "forfeit",
  });

  // No claim round is needed - the close proceeds straight to the normal close, which has
  // no other subentries here, so it builds the single-transaction merge.
  expect(result.transactions).toHaveLength(1);
  const ops = opsOf(result.transactions[0].xdr);
  expect(ops.some((o) => o.type === "claimClaimableBalance")).toBe(false);
  expect(ops.some((o) => o.type === "changeTrust")).toBe(false);
});

test("buildCloseTransactions › unresolved unclaimable balance → excluded from the claim round entirely", async () => {
  mock.module("@/lib/stellar/rpc", () => ({ getRpcServer: () => rpcServerStub() }));
  const { buildCloseTransactions } = await import("@/lib/close-api/build-transactions");

  const balance = claimableBalance("c", USDC);
  const state = accountState({ claimableBalances: [balance] });

  const result = await buildCloseTransactions(state, DEST, {}, "testnet");

  expect(result.transactions).toHaveLength(1);
  const ops = opsOf(result.transactions[0].xdr);
  expect(ops.some((o) => o.type === "claimClaimableBalance")).toBe(false);
});

test("buildCloseTransactions › currently-claimable balance defaults to claim when unresolved (opt-out)", async () => {
  mock.module("@/lib/stellar/rpc", () => ({ getRpcServer: () => rpcServerStub() }));
  const { buildCloseTransactions } = await import("@/lib/close-api/build-transactions");

  const balance = claimableBalance("d", "native");
  const state = accountState({ claimableBalances: [balance] });

  const result = await buildCloseTransactions(state, DEST, {}, "testnet");

  expect(result.requiresAnotherCall).toBe(true);
  const ops = opsOf(result.transactions[0].xdr);
  expect(ops.some((o) => o.type === "claimClaimableBalance")).toBe(true);
});

test("buildCloseTransactions › currently-claimable balance explicitly forfeited is excluded", async () => {
  mock.module("@/lib/stellar/rpc", () => ({ getRpcServer: () => rpcServerStub() }));
  const { buildCloseTransactions } = await import("@/lib/close-api/build-transactions");

  const balance = claimableBalance("e", "native");
  const state = accountState({ claimableBalances: [balance] });

  const result = await buildCloseTransactions(state, DEST, {}, "testnet", null, {
    [balance.id]: "forfeit",
  });

  expect(result.transactions).toHaveLength(1);
  const ops = opsOf(result.transactions[0].xdr);
  expect(ops.some((o) => o.type === "claimClaimableBalance")).toBe(false);
});

// Regression coverage for the "live re-read before build" invariant: buildCloseTransactions
// must call assessSponsorshipAffordability itself, immediately before building, rather than
// trusting whatever /close/plan decided minutes earlier - the sponsored owner's on-chain
// reserve state can change in between.
const SPONSORED_ENTRY: SponsoredEntry = { kind: "signer", owner: ISSUER, signerKey: Keypair.random().publicKey() };

test("buildCloseTransactions › sponsored entry the live re-read marks revocable → REVOKE_SPONSORSHIP is included", async () => {
  mock.module("@/lib/stellar/rpc", () => ({ getRpcServer: () => rpcServerStub() }));
  mock.module("@/lib/stellar/sponsorship-affordability", () => ({
    assessSponsorshipAffordability: () =>
      Promise.resolve({ revocable: [SPONSORED_ENTRY], unaffordableOwners: new Map() }),
  }));
  const { buildCloseTransactions } = await import("@/lib/close-api/build-transactions");

  const state = accountState({ sponsoredEntries: [SPONSORED_ENTRY], numSponsoring: 1 });
  const result = await buildCloseTransactions(state, DEST, {}, "testnet");

  expect(result.transactions).toHaveLength(1);
  expect(result.transactions[0].covers).toContain("REVOKE_SPONSORSHIP");
  const ops = opsOf(result.transactions[0].xdr);
  expect(ops.some((o) => o.type === "revokeSignerSponsorship")).toBe(true);
});

test("buildCloseTransactions › sponsored entry the live re-read marks unaffordable → REVOKE_SPONSORSHIP is omitted, no error", async () => {
  mock.module("@/lib/stellar/rpc", () => ({ getRpcServer: () => rpcServerStub() }));
  mock.module("@/lib/stellar/sponsorship-affordability", () => ({
    assessSponsorshipAffordability: () =>
      Promise.resolve({
        revocable: [],
        unaffordableOwners: new Map([[ISSUER, { entries: [SPONSORED_ENTRY], shortfallXlm: "0.5000000" }]]),
      }),
  }));
  const { buildCloseTransactions } = await import("@/lib/close-api/build-transactions");

  const state = accountState({ sponsoredEntries: [SPONSORED_ENTRY], numSponsoring: 1 });
  const result = await buildCloseTransactions(state, DEST, {}, "testnet");

  expect(result.transactions).toHaveLength(1);
  expect(result.transactions[0].covers).not.toContain("REVOKE_SPONSORSHIP");
  const ops = opsOf(result.transactions[0].xdr);
  expect(ops.some((o) => o.type === "revokeSignerSponsorship")).toBe(false);
});
