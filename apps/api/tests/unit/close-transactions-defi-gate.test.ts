import { expect, test } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import type { AccountState } from "@lumenwipe/types";
import { buildCloseTransactions, CloseBuildError } from "@/lib/close-api/build-transactions";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";

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
