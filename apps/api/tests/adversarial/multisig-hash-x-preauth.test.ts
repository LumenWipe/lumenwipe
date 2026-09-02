/**
 * Adversarial coverage: multisig with hash(x) and pre-auth signers (docs/architecture.md §17,
 * issue #167).
 *
 * The weight/threshold gating logic is already well covered at the `buildPlan()` decision layer
 * in buildPlan.test.ts (including the exact "master weight 0 despite a satisfiable co-signer"
 * and "hash_x/preauth_tx weight alone satisfies the threshold" cases this hostile state names),
 * and op-construction correctness is covered per-signer-type in signers.test.ts. This file covers
 * the two gaps research for #167 found:
 *
 *  (a) The regression test for this PR's fix: apps/api/src/lib/close-api/build-transactions.ts
 *      never re-checked buildPlan()'s masterWeight/satisfiableWeight blockers before building a
 *      signable transaction. A weight-0 master key with a satisfiable co-signer is the exact fund
 *      lock PR #125 (the multisig-hardening epic) fixed once already for buildPlan() - unfixed
 *      here, it was reachable through @lumenwipe/sdk's runClose, which calls
 *      /close/transactions directly with no /close/plan call in its own loop.
 *  (b) signers.test.ts only ever normalizes one extra signer at a time. This proves
 *      signerNormalizationOps handles a genuinely mixed hostile signer set - hash_x and
 *      preauth_tx together, at different weights - not just each type in isolation.
 */
import { test, expect, spyOn, afterEach, mock } from "bun:test";
import {
  Account,
  Keypair,
  Operation,
  StrKey,
  TransactionBuilder,
  Networks,
  xdr,
} from "@stellar/stellar-sdk";
import * as rpcModule from "@/lib/stellar/rpc";
import { buildCloseTransactions, CloseBuildError } from "@/lib/close-api/build-transactions";
import { signerNormalizationOps } from "@/lib/stellar/tx-builder/signers";
import type { AccountSigner, AccountState } from "@lumenwipe/types";
import { emptyDefiPositionsResult } from "../unit/fixtures/defi-positions";

const MASTER = Keypair.random().publicKey();
const CO_SIGNER_KP = Keypair.random();
const DEST = Keypair.random().publicKey();

afterEach(() => {
  mock.restore();
});

function rpcServerStub() {
  return {
    getAccount: () => Promise.resolve(new Account(MASTER, "100")),
    getLatestLedger: () => Promise.resolve({ sequence: 1000 }),
    getLedgerEntries: () => Promise.reject(new Error("should be refused before any live read")),
    getAssetBalance: () => Promise.reject(new Error("should be refused before any live read")),
  } as unknown as ReturnType<typeof rpcModule.getRpcServer>;
}

function accountState(
  signers: AccountSigner[],
  thresholds = { low: 0, med: 1, high: 1 }
): AccountState {
  return {
    address: MASTER,
    network: "testnet",
    sequence: "100",
    nativeBalanceLumens: "5.0000000",
    dataEntries: [],
    signers,
    thresholds,
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
    defiPositions: emptyDefiPositionsResult(MASTER),
    defiPositionsWarnings: [],
  };
}

// ─── (a) build-transactions.ts regression: the fix from this PR ─────────────────────────────

test("close/transactions refuses to build a normalization that would strand a weight-0 master key", async () => {
  spyOn(rpcModule, "getRpcServer").mockReturnValue(rpcServerStub());

  // A completely standard multisig configuration: the master key is deliberately at weight 0,
  // and a single co-signer this app CAN satisfy (hash_x) carries all the real weight. This is
  // not a synthetic or malicious account state - it's a normal delegated-signing setup.
  const state = accountState([
    { key: MASTER, weight: 0, type: "ed25519_public_key" },
    { key: StrKey.encodeSha256Hash(CO_SIGNER_KP.rawPublicKey()), weight: 1, type: "hash_x" },
  ]);

  const err = await buildCloseTransactions(state, DEST, {}, "testnet").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(CloseBuildError);
  expect((err as CloseBuildError).code).toBe("signer_normalization_unsafe");
  expect((err as CloseBuildError).status).toBe(422);
  expect((err as Error).message).toContain("weight 0");
});

test("close/transactions refuses to build a normalization no satisfiable signer combination could ever authorize", async () => {
  spyOn(rpcModule, "getRpcServer").mockReturnValue(rpcServerStub());

  // High threshold of 3, but the only satisfiable weight available (master's own 1) can never
  // reach it - the account requires a signed-payload signer this flow has no path to satisfy.
  const state = accountState(
    [
      { key: MASTER, weight: 1, type: "ed25519_public_key" },
      {
        key: StrKey.encodeSignedPayload(
          new xdr.SignerKeyEd25519SignedPayload({
            ed25519: CO_SIGNER_KP.rawPublicKey(),
            payload: Buffer.from("hostile-payload"),
          }).toXDR()
        ),
        weight: 2,
        type: "ed25519_signed_payload",
      },
    ],
    { low: 0, med: 1, high: 3 }
  );

  const err = await buildCloseTransactions(state, DEST, {}, "testnet").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(CloseBuildError);
  expect((err as CloseBuildError).code).toBe("signer_normalization_unsafe");
});

test("close/transactions builds normally once the same account's master key carries real weight", async () => {
  spyOn(rpcModule, "getRpcServer").mockReturnValue(rpcServerStub());

  const state = accountState([
    { key: MASTER, weight: 1, type: "ed25519_public_key" },
    { key: StrKey.encodeSha256Hash(CO_SIGNER_KP.rawPublicKey()), weight: 1, type: "hash_x" },
  ]);

  const result = await buildCloseTransactions(state, DEST, {}, "testnet");
  const ops = TransactionBuilder.fromXDR(result.transactions[0]!.xdr, Networks.TESTNET).operations;
  expect(ops.some((o) => o.type === "setOptions")).toBe(true);
});

// ─── (b) a mixed hash_x + preauth_tx normalization, not just one signer type at a time ──────

test("signerNormalizationOps removes a mixed hash_x and preauth_tx signer set in one call", () => {
  const hashXSigner = StrKey.encodeSha256Hash(Keypair.random().rawPublicKey());
  const preAuthSigner = StrKey.encodePreAuthTx(Keypair.random().rawPublicKey());
  const signers: AccountSigner[] = [
    { key: MASTER, weight: 1, type: "ed25519_public_key" },
    { key: hashXSigner, weight: 2, type: "hash_x" },
    { key: preAuthSigner, weight: 3, type: "preauth_tx" },
  ];

  const ops = signerNormalizationOps(signers, MASTER);
  // Two removals plus the threshold reset - the master key itself is never touched.
  expect(ops).toHaveLength(3);

  const decoded = ops.map((op) => Operation.fromXDRObject(op));
  const removals = decoded.slice(0, 2) as Array<{
    type: string;
    signer: { sha256Hash?: Buffer; preAuthTx?: Buffer; weight: number };
  }>;
  expect(removals.every((r) => r.type === "setOptions")).toBe(true);
  expect(removals.every((r) => r.signer.weight === 0)).toBe(true);

  const removedHashX = removals.find((r) => r.signer.sha256Hash !== undefined);
  const removedPreAuth = removals.find((r) => r.signer.preAuthTx !== undefined);
  expect(removedHashX).toBeDefined();
  expect(removedPreAuth).toBeDefined();
  expect(StrKey.encodeSha256Hash(removedHashX!.signer.sha256Hash!)).toBe(hashXSigner);
  expect(StrKey.encodePreAuthTx(removedPreAuth!.signer.preAuthTx!)).toBe(preAuthSigner);

  const thresholdReset = decoded[2] as {
    type: string;
    lowThreshold?: number;
    medThreshold?: number;
    highThreshold?: number;
  };
  expect(thresholdReset.type).toBe("setOptions");
  expect(thresholdReset.lowThreshold).toBe(0);
  expect(thresholdReset.medThreshold).toBe(1);
  expect(thresholdReset.highThreshold).toBe(1);
});
