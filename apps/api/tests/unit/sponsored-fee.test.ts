/**
 * Sponsored-fee detection (#165, architecture.md §8.1): an account at exactly its reserve
 * cannot pay even its own close's fee, so the close builder must set that transaction's fee to
 * zero and flag it for fee-bump sponsorship instead of trying, and failing, to build it normally.
 */
import { expect, test } from "bun:test";
import { Account, Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import {
  accountCanAffordFee,
  packFusedCloseTransactions,
} from "@/lib/close-api/build-transactions";
import type { FusedCloseInput } from "@/lib/stellar/tx-builder/fused-close";

const MASTER = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const START_SEQ = "100";

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

// The classic close here is one operation (the merge): 100 stroops at the base fee.
const ONE_OP_FEE = 100n;

test("accountCanAffordFee › exactly at the reserve line, a fee of any size is refused; one stroop more, and it's affordable", () => {
  // Base reserve 1 XLM + 0 subentries: nothing above the reserve to spend on a fee at all.
  const atReserve = { nativeBalanceLumens: "1.0000000", numSubEntries: 0, numSponsoring: 0 };
  expect(accountCanAffordFee(atReserve, 1n)).toBe(false);
  expect(accountCanAffordFee(atReserve, 0n)).toBe(true); // a zero fee never needs sponsorship

  const oneStroopOver = { nativeBalanceLumens: "1.0000001", numSubEntries: 0, numSponsoring: 0 };
  expect(accountCanAffordFee(oneStroopOver, 1n)).toBe(true);
  expect(accountCanAffordFee(oneStroopOver, 2n)).toBe(false);
});

test("accountCanAffordFee › a sponsored entry costs a reserve exactly like a subentry does", () => {
  // 1 XLM base + 0.5 XLM per (subentry + sponsoring) - one of each is the same reserve as two
  // of either, so the two accounts below must answer identically.
  const twoSubentries = { nativeBalanceLumens: "2.0000000", numSubEntries: 2, numSponsoring: 0 };
  const oneOfEach = { nativeBalanceLumens: "2.0000000", numSubEntries: 1, numSponsoring: 1 };
  expect(accountCanAffordFee(twoSubentries, 0n)).toBe(accountCanAffordFee(oneOfEach, 0n));
  expect(accountCanAffordFee(twoSubentries, 0n)).toBe(true);
  expect(accountCanAffordFee(twoSubentries, 1n)).toBe(false);
});

test("packFusedCloseTransactions › a reserve-locked account gets a zero-fee transaction flagged for sponsorship", () => {
  const lockedTxs = packFusedCloseTransactions(
    new Account(MASTER, START_SEQ),
    input(),
    "testnet",
    999,
    { nativeBalanceLumens: "1.0000000", numSubEntries: 0, numSponsoring: 0 }
  );
  expect(lockedTxs).toHaveLength(1);
  expect(lockedTxs[0]!.needsSponsoredFee).toBe(true);
  const tx = TransactionBuilder.fromXDR(lockedTxs[0]!.xdr, Networks.TESTNET);
  expect(tx.fee).toBe("0");
});

test("packFusedCloseTransactions › an account with room to spare pays its own way, unflagged", () => {
  const fundedTxs = packFusedCloseTransactions(
    new Account(MASTER, START_SEQ),
    input(),
    "testnet",
    999,
    { nativeBalanceLumens: "100.0000000", numSubEntries: 0, numSponsoring: 0 }
  );
  expect(fundedTxs).toHaveLength(1);
  expect(fundedTxs[0]!.needsSponsoredFee).toBeUndefined();
  const tx = TransactionBuilder.fromXDR(fundedTxs[0]!.xdr, Networks.TESTNET);
  expect(tx.fee).toBe(ONE_OP_FEE.toString());
});

test("packFusedCloseTransactions › exactly enough for this transaction's fee is not locked", () => {
  // Base reserve 1 XLM, plus exactly the fee this one-operation close will cost.
  const exact = {
    nativeBalanceLumens: (1 + Number(ONE_OP_FEE) / 10_000_000).toFixed(7),
    numSubEntries: 0,
    numSponsoring: 0,
  };
  const txs = packFusedCloseTransactions(
    new Account(MASTER, START_SEQ),
    input(),
    "testnet",
    999,
    exact
  );
  expect(txs[0]!.needsSponsoredFee).toBeUndefined();
});
