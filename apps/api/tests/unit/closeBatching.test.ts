import { test, expect } from "bun:test";
import { Account, Keypair, TransactionBuilder, Transaction, Networks } from "@stellar/stellar-sdk";
import { assembleFusedCloseOpsTagged, type FusedCloseInput } from "@/lib/stellar/tx-builder/fused-close";
import { revokeSponsorshipOps } from "@/lib/stellar/tx-builder/sponsorship";
import { packFusedCloseTransactions } from "@/lib/close-api/build-transactions";
import type { SponsoredEntry } from "@lumenwipe/types";

const MASTER = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const START_SEQ = "100";

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

test("a close that fits under the op cap yields a single fused transaction", () => {
  const txs = packFusedCloseTransactions(
    new Account(MASTER, START_SEQ),
    input({ trustlines: manyTrustlines(3) }),
    "testnet",
    999
  );
  expect(txs).toHaveLength(1);
  expect(txs[0].id).toBe("tx-1");
  expect(txs[0].dependsOn).toEqual([]);
  expect(txs[0].covers).toContain("MERGE");
  expect(opCount(txs[0].xdr)).toBe(4); // 3 trustline removals + merge
});

test("a close over the op cap is split into sequence-chained transactions with the merge last", () => {
  const in_ = input({ trustlines: manyTrustlines(150) });
  const total = assembleFusedCloseOpsTagged(MASTER, in_).length; // 150 removals + merge

  const txs = packFusedCloseTransactions(new Account(MASTER, START_SEQ), in_, "testnet", 999);

  // More than one tx, none over the 100-op cap, and every op accounted for.
  expect(txs.length).toBeGreaterThan(1);
  const counts = txs.map((t) => opCount(t.xdr));
  for (const c of counts) expect(c).toBeLessThanOrEqual(100);
  expect(counts.reduce((a, b) => a + b, 0)).toBe(total);

  // order / dependsOn form a chain.
  txs.forEach((t, i) => {
    expect(t.order).toBe(i);
    expect(t.dependsOn).toEqual(i === 0 ? [] : [`tx-${i}`]);
  });

  // The merge lands only in the last transaction.
  const last = txs[txs.length - 1];
  expect(last.covers).toContain("MERGE");
  for (const t of txs.slice(0, -1)) expect(t.covers).not.toContain("MERGE");

  // Sequence numbers are chained: each built tx is the previous + 1, starting at START_SEQ + 1.
  const seqs = txs.map((t) => (TransactionBuilder.fromXDR(t.xdr, Networks.TESTNET) as Transaction).sequence);
  expect(BigInt(seqs[0])).toBe(BigInt(START_SEQ) + 1n);
  seqs.forEach((s, i) => {
    if (i > 0) expect(BigInt(s)).toBe(BigInt(seqs[i - 1]) + 1n);
  });
  // Reported sourceSequence is the account sequence the first tx builds on.
  expect(txs[0].sourceSequence).toBe(START_SEQ);
});

function claimables(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `00000000${i.toString(16).padStart(64, "0")}`,
    asset: `AST${i}:${ISSUER}`,
    amount: "1",
    claimants: [{ destination: MASTER, predicate: { type: "unconditional" as const } }],
    sponsor: null,
  }));
}

test("a claim-only round produces claim transactions with no merge", () => {
  const txs = packFusedCloseTransactions(
    new Account(MASTER, START_SEQ),
    input({ claimableBalances: claimables(3), includeMerge: false }),
    "testnet",
    999
  );
  expect(txs).toHaveLength(1);
  expect(opCount(txs[0].xdr)).toBe(3);
  expect(txs[0].covers).toEqual(["CLAIM_BALANCES"]);
  expect(txs.some((t) => t.covers.includes("MERGE"))).toBe(false);
});

test("claims over the op cap are split into sequence-chained transactions", () => {
  const txs = packFusedCloseTransactions(
    new Account(MASTER, START_SEQ),
    input({ claimableBalances: claimables(150), includeMerge: false }),
    "testnet",
    999
  );
  expect(txs.length).toBeGreaterThan(1);
  for (const t of txs) {
    expect(opCount(t.xdr)).toBeLessThanOrEqual(100);
    expect(t.covers).toEqual(["CLAIM_BALANCES"]);
  }
});

function sponsoredEntries(): SponsoredEntry[] {
  return [
    { kind: "account", owner: MASTER },
    { kind: "trustline", owner: MASTER, asset: `AST0:${ISSUER}` },
  ];
}

test("non-empty revokeSponsorshipEntries produce REVOKE_SPONSORSHIP-tagged ops matching revokeSponsorshipOps' count", () => {
  const entries = sponsoredEntries();
  const tagged = assembleFusedCloseOpsTagged(MASTER, input({ revokeSponsorshipEntries: entries }));
  const revokeTagged = tagged.filter((t) => t.step === "REVOKE_SPONSORSHIP");
  expect(revokeTagged).toHaveLength(revokeSponsorshipOps(entries).length);
  expect(revokeTagged).toHaveLength(2);
});

test("empty revokeSponsorshipEntries produces no REVOKE_SPONSORSHIP-tagged ops", () => {
  const tagged = assembleFusedCloseOpsTagged(MASTER, input({ revokeSponsorshipEntries: [] }));
  expect(tagged.some((t) => t.step === "REVOKE_SPONSORSHIP")).toBe(false);
});

test("REVOKE_SPONSORSHIP-tagged ops appear before REMOVE_DATA_ENTRIES-tagged ops", () => {
  const tagged = assembleFusedCloseOpsTagged(
    MASTER,
    input({
      revokeSponsorshipEntries: sponsoredEntries(),
      dataEntries: [{ key: "k", value: "" }],
    })
  );
  const revokeIndexes = tagged.flatMap((t, i) => (t.step === "REVOKE_SPONSORSHIP" ? [i] : []));
  const dataIndexes = tagged.flatMap((t, i) => (t.step === "REMOVE_DATA_ENTRIES" ? [i] : []));
  expect(revokeIndexes.length).toBeGreaterThan(0);
  expect(dataIndexes.length).toBeGreaterThan(0);
  expect(Math.max(...revokeIndexes)).toBeLessThan(Math.min(...dataIndexes));
});
