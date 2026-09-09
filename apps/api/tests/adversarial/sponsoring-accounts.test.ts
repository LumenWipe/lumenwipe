/**
 * Adversarial coverage: sponsoring accounts (docs/architecture.md §17, issue #167).
 *
 * The bulk of this hostile state is already thoroughly covered elsewhere -
 * sponsorship-affordability.test.ts, sponsorship-reconcile.test.ts, sponsorship-io.test.ts, and
 * tx-builder-sponsorship.test.ts - and this file does not duplicate that. It targets the one gap
 * research for #167 found: apps/api/src/lib/close-api/build-transactions.ts calls
 * `assessSponsorshipAffordability` a second time, independently of `buildPlan()`'s own call, per
 * its own comment ("Live re-read immediately before build... a deliberate, separate call, not a
 * reuse of the plan-time result"). Only the plan-time call site had test coverage before this file -
 * this proves the build-time call is a genuine live re-read, not a silent pass-through of whatever
 * `buildPlan()` decided minutes earlier.
 *
 * Spies directly on `assessSponsorshipAffordability`, the exact function build-transactions.ts
 * calls, with `spyOn` rather than `mock.module` - `mock.module` replaces a module's whole export
 * object in Bun's process-global registry, which is what caused this file to observe another
 * suite's leaked mock of this same module when run as part of the full test process (confirmed by
 * bisection). `spyOn` patches one named export on the already-loaded module object in place.
 */
import { test, expect, spyOn, afterEach, mock } from "bun:test";
import { Account, Keypair, TransactionBuilder, Networks } from "@stellar/stellar-sdk";
import * as rpcModule from "@/lib/stellar/rpc";
import * as sponsorshipAffordabilityModule from "@/lib/stellar/sponsorship-affordability";
import { buildCloseTransactions } from "@/lib/close-api/build-transactions";
import type { AccountState, SponsoredEntry } from "@lumenwipe/types";
import { emptyDefiPositionsResult } from "../unit/fixtures/defi-positions";

const SOURCE = Keypair.random().publicKey();
const OWNER = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const USDC = `USDC:${ISSUER}`;

afterEach(() => {
  mock.restore();
});

function rpcServerStub() {
  return {
    getAccount: () => Promise.resolve(new Account(SOURCE, "100")),
    getLatestLedger: () => Promise.resolve({ sequence: 1000 }),
    getLedgerEntries: () => Promise.reject(new Error("not stubbed")),
    getAssetBalance: () => Promise.reject(new Error("not stubbed")),
  } as unknown as ReturnType<typeof rpcModule.getRpcServer>;
}

const SPONSORED_ENTRIES: SponsoredEntry[] = [{ kind: "trustline", owner: OWNER, asset: USDC }];

function accountState(): AccountState {
  return {
    address: SOURCE,
    network: "testnet",
    sequence: "100",
    nativeBalanceLumens: "5.0000000",
    dataEntries: [],
    signers: [{ key: SOURCE, weight: 1, type: "ed25519_public_key" }],
    thresholds: { low: 0, med: 1, high: 1 },
    numSubEntries: 1,
    numSponsoring: 1,
    sponsoredBy: null,
    authImmutable: false,
    trustlines: [],
    openOffers: [],
    poolShares: [],
    claimableBalances: [],
    subEntryMismatch: false,
    sponsoredEntries: SPONSORED_ENTRIES,
    sponsorshipEnumerationIncomplete: false,
    defiPositions: emptyDefiPositionsResult(SOURCE),
    defiPositionsWarnings: [],
  };
}

function opsOf(xdr: string) {
  return TransactionBuilder.fromXDR(xdr, Networks.TESTNET).operations;
}

test("build-transactions re-reads sponsorship affordability live, independent of any plan-time result", async () => {
  spyOn(rpcModule, "getRpcServer").mockReturnValue(rpcServerStub());
  // Build-time: the live read now reports the owner as unaffordable - a real drift between
  // when a caller might have called /close/plan (which could have seen "affordable") and when
  // it calls /close/transactions. If build-transactions.ts were reusing a stale plan-time
  // assumption instead of calling this function fresh, this spy alone couldn't influence the
  // built ops - the point is that this spy is the ONLY source of truth build-transactions.ts
  // has for affordability here.
  spyOn(sponsorshipAffordabilityModule, "assessSponsorshipAffordability").mockResolvedValue({
    revocable: [],
    unaffordableOwners: new Map([[OWNER, { entries: SPONSORED_ENTRIES, shortfallXlm: "5" }]]),
  });

  const result = await buildCloseTransactions(accountState(), DEST, {}, "testnet");

  const ops = opsOf(result.transactions[0]!.xdr);
  // Unaffordable per the live (build-time) read: no revoke-sponsorship op is built for it.
  expect(ops.some((o) => o.type === "revokeTrustlineSponsorship")).toBe(false);
});

test("build-transactions includes the revoke when the live read confirms it's affordable", async () => {
  spyOn(rpcModule, "getRpcServer").mockReturnValue(rpcServerStub());
  spyOn(sponsorshipAffordabilityModule, "assessSponsorshipAffordability").mockResolvedValue({
    revocable: SPONSORED_ENTRIES,
    unaffordableOwners: new Map(),
  });

  const result = await buildCloseTransactions(accountState(), DEST, {}, "testnet");

  const ops = opsOf(result.transactions[0]!.xdr);
  expect(ops.some((o) => o.type === "revokeTrustlineSponsorship")).toBe(true);
});
