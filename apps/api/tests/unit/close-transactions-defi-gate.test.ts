import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Account, Keypair } from "@stellar/stellar-sdk";
import type { AccountState } from "@lumenwipe/types";
import { buildCloseTransactions, CloseBuildError } from "@/lib/close-api/build-transactions";
import { DEGRADED_SOURCE_CONFIRMED } from "@/lib/defi-positions/resolve-defi-positions";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";
import * as rpcModule from "@/lib/stellar/rpc";

// /close/transactions must refuse the same unconfirmed-positions states the plan blocks on: an
// SDK caller never requests a plan, and a web session's plan may be minutes old. The gate runs
// before any network read, so no RPC stub is needed - a call that reached the network would fail
// loudly here rather than pass.

const SOURCE = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();

function state(over: Partial<AccountState["defiPositions"]>): AccountState {
  return {
    address: SOURCE,
    network: "testnet",
    sequence: "1",
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
    defiPositions: { ...emptyDefiPositionsResult(SOURCE), ...over },
    defiPositionsWarnings: [],
  };
}

test("positions that could not be confirmed (no snapshot) refuse the build with the plan's own code", async () => {
  const promise = buildCloseTransactions(state({ timestamp: null }), DEST, {}, "testnet");
  await expect(promise).rejects.toBeInstanceOf(CloseBuildError);
  await expect(promise).rejects.toMatchObject({
    code: "defi_positions_unavailable",
    status: 422,
  });
});

test("a position detection could not read refuses the build", async () => {
  const promise = buildCloseTransactions(
    state({
      unrecognizedPositions: [
        { protocol: "fxdao", rawType: "wasmhash-mismatch", reason: "hash differs" },
      ],
    }),
    DEST,
    {},
    "testnet"
  );
  await expect(promise).rejects.toMatchObject({ code: "defi_position_unrecognized", status: 422 });
});

test("a stale snapshot refuses the build", async () => {
  const old = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const promise = buildCloseTransactions(state({ timestamp: old }), DEST, {}, "testnet");
  await expect(promise).rejects.toMatchObject({ code: "defi_positions_stale", status: 422 });
});

afterEach(() => {
  mock.restore();
});

test("a confirmed-empty degraded result on a zero-trustline account does not refuse the build", async () => {
  spyOn(rpcModule, "getRpcServer").mockImplementation((() => ({
    getAccount: () => Promise.resolve(new Account(SOURCE, "100")),
    getLatestLedger: () => Promise.resolve({ sequence: 1000 }),
    getLedgerEntries: () => Promise.reject(new Error("not stubbed")),
  })) as unknown as typeof rpcModule.getRpcServer);

  const result = await buildCloseTransactions(
    state({ source: DEGRADED_SOURCE_CONFIRMED, timestamp: null }),
    DEST,
    {},
    "testnet"
  );

  expect(result.requiresAnotherCall).toBeDefined();
});

// Regression: a real mainnet account had OctoPos down, a completed direct-read sweep that found
// a genuine, fully-recognized Blend supply position, and was still refused with the gate's
// generic "could not be confirmed" error - the exact position the plan already knew how to
// exit. The Blend exit adapter itself has its own dedicated test suite
// (blend-exit-adapter.test.ts); this only proves the confirmation gate is not why this fails -
// whatever happens deeper in the exit round (RPC is not fully stubbed here) is out of scope.
test("a confirmed sweep with a real detected position is never refused by the confirmation gate", async () => {
  spyOn(rpcModule, "getRpcServer").mockImplementation((() => ({
    getAccount: () => Promise.resolve(new Account(SOURCE, "100")),
    getLatestLedger: () => Promise.resolve({ sequence: 1000 }),
    getLedgerEntries: () => Promise.reject(new Error("not stubbed")),
  })) as unknown as typeof rpcModule.getRpcServer);

  const promise = buildCloseTransactions(
    state({
      source: DEGRADED_SOURCE_CONFIRMED,
      timestamp: null,
      positions: [
        {
          protocol: "blend",
          positionType: "supply",
          contractAddress: "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD",
          assetAddress: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
          bTokenAmount: "99997766",
          usdValue: null,
        },
      ],
    }),
    DEST,
    {},
    "testnet"
  );

  // Whatever happens deeper in the exit round is out of scope (it may legitimately throw its
  // own CloseBuildError for an unrelated reason, given RPC is not fully stubbed here) - only the
  // confirmation gate's own codes must never be why this specific call fails.
  await promise.catch((err) => {
    if (err instanceof CloseBuildError) {
      expect(err.code).not.toBe("defi_positions_unavailable");
      expect(err.code).not.toBe("defi_positions_unconfirmed_but_detected");
    }
  });
});
