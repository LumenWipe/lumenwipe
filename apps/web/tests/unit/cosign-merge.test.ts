import { describe, expect, test } from "bun:test";
import {
  Account,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import type { CloseTransaction, PendingRound } from "@lumenwipe/sdk";
import { parseCosignArtifact, type CosignArtifact } from "@/lib/cosign/artifact";
import {
  assertStillSignable,
  COSIGN_REFUSED,
  COSIGN_UNAVAILABLE,
  cosignExport,
  envelopeWith,
  minimalSignatureSet,
  roundSignatures,
  verifyResponse,
  type PoolSignature,
} from "@/lib/cosign/merge";
import { IMPORT_FLOOR_SECONDS } from "@/lib/cosign/station-checks";
import { toHex } from "@/lib/stellar/hex";
import { UserFacingError } from "@/lib/utils/user-error";
import type { AccountSigner } from "@/types/account";

const master = Keypair.random();
const b = Keypair.random();
const c = Keypair.random();
const ACCOUNT = master.publicKey();
const NOW = Math.floor(Date.now() / 1000);
const PASSPHRASE = Networks.TESTNET;

const SIGNERS: AccountSigner[] = [
  { key: ACCOUNT, weight: 1, type: "ed25519_public_key" },
  { key: b.publicKey(), weight: 1, type: "ed25519_public_key" },
  { key: c.publicKey(), weight: 1, type: "ed25519_public_key" },
];
const LIVE = { sequence: "100", signers: SIGNERS, thresholds: { low: 0, med: 3, high: 3 } };

const removal = (key: string): xdr.Operation =>
  Operation.setOptions({ signer: { ed25519PublicKey: key, weight: 0 } });
const RESET = Operation.setOptions({ lowThreshold: 0, medThreshold: 1, highThreshold: 1 });

function buildTx(
  ops: xdr.Operation[] = [removal(b.publicKey()), removal(c.publicKey()), RESET],
  maxTime = NOW + 300,
  passphrase = PASSPHRASE
): Transaction {
  const builder = new TransactionBuilder(new Account(ACCOUNT, "100"), {
    fee: "100",
    networkPassphrase: passphrase,
  }).setTimebounds(0, maxTime);
  for (const op of ops) builder.addOperation(op);
  return builder.build();
}

function roundOf(tx: Transaction, signedBy: Keypair[] = [master], pinned = true): PendingRound {
  const hash = toHex(tx.hash());
  const signed = TransactionBuilder.fromXdr(tx.toEnvelope().toXDR("base64"), PASSPHRASE);
  for (const key of signedBy) signed.sign(key);
  return {
    tx: { xdr: tx.toEnvelope().toXDR("base64") } as CloseTransaction,
    xdr: signed.toEnvelope().toXDR("base64"),
    queue: [],
    requiresAnotherCall: true,
    accumulatedWeight: signedBy.length,
    requiredWeight: 3,
    round: 0,
    txIndex: 0,
    ...(pinned && { approvedHash: hash }),
  } as PendingRound;
}

function responseFor(tx: Transaction, keys: Keypair[], passphrase = PASSPHRASE): CosignArtifact {
  const signed = TransactionBuilder.fromXdr(tx.toEnvelope().toXDR("base64"), passphrase);
  for (const key of keys) signed.sign(key);
  return {
    direction: "response",
    network: "testnet",
    account: ACCOUNT,
    envelope: signed.toEnvelope().toXDR("base64"),
  };
}

function refusalOf(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    if (err instanceof UserFacingError) return err.message;
    throw err;
  }
  throw new Error("accepted");
}

describe("cosignExport", () => {
  const exportOf = (round: PendingRound, nowSeconds = NOW) =>
    cosignExport({
      round,
      network: "testnet",
      account: ACCOUNT,
      signers: SIGNERS,
      passphrase: PASSPHRASE,
      nowSeconds,
    });

  test("exports the unsigned request of a pinned normalization the master key signed", () => {
    const tx = buildTx();
    const result = exportOf(roundOf(tx));
    if (!result.available) throw new Error(result.reason);
    const artifact = parseCosignArtifact(result.request, "request");
    expect(artifact.envelope).toBe(tx.toEnvelope().toXDR("base64"));
    expect(result.hash).toBe(toHex(tx.hash()));
    expect(result.request).not.toContain(result.hash);
    expect(Object.keys(JSON.parse(result.request))).toHaveLength(6);
  });

  test("is not offered for an unpinned round", () => {
    expect(exportOf(roundOf(buildTx(), [master], false))).toEqual({
      available: false,
      reason: COSIGN_UNAVAILABLE.notPinned,
    });
  });

  test("is not offered for a round that removes only some of the other signers", () => {
    const partial = buildTx([removal(b.publicKey()), RESET]);
    expect(exportOf(roundOf(partial))).toEqual({
      available: false,
      reason: COSIGN_UNAVAILABLE.notNormalization,
    });
  });

  test("is not offered before the master key signed", () => {
    expect(exportOf(roundOf(buildTx(), [b]))).toEqual({
      available: false,
      reason: COSIGN_UNAVAILABLE.noMaster,
    });
  });

  test("is not offered with less time left than the station accepts", () => {
    const round = roundOf(buildTx(undefined, NOW + 300));
    expect(exportOf(round, NOW + 300 - IMPORT_FLOOR_SECONDS + 1)).toEqual({
      available: false,
      reason: COSIGN_UNAVAILABLE.expiring,
    });
    expect(exportOf(round, NOW + 300 - IMPORT_FLOOR_SECONDS).available).toBe(true);
  });
});

describe("verifyResponse", () => {
  const tx = buildTx();
  const round = roundOf(tx);
  const pool = roundSignatures(round, SIGNERS, PASSPHRASE);
  const verify = (artifact: CosignArtifact, signers = SIGNERS, given = pool) =>
    verifyResponse({
      artifact,
      round,
      network: "testnet",
      account: ACCOUNT,
      signers,
      passphrase: PASSPHRASE,
      pool: given,
    });

  test("takes the cosigner's verified signature", () => {
    const added = verify(responseFor(tx, [b]));
    expect(added.map((s) => [s.key, s.weight])).toEqual([[b.publicKey(), 1]]);
    expect(pool.map((s) => s.key)).toEqual([ACCOUNT]);
  });

  test("refuses a response for another round", () => {
    expect(refusalOf(() => verify(responseFor(buildTx(undefined, NOW + 200), [b])))).toBe(
      COSIGN_REFUSED.otherRound
    );
  });

  test("judges a response by the hash pinned at verify time, not by the round's envelope", () => {
    const other = buildTx(undefined, NOW + 250);
    const swapped = { ...round, xdr: roundOf(other).xdr };
    expect(
      refusalOf(() =>
        verifyResponse({
          artifact: responseFor(other, [b]),
          round: swapped,
          network: "testnet",
          account: ACCOUNT,
          signers: SIGNERS,
          passphrase: PASSPHRASE,
          pool,
        })
      )
    ).toBe(COSIGN_REFUSED.otherRound);
  });

  test("refuses a response for another account or network", () => {
    const other = { ...responseFor(tx, [b]), account: Keypair.random().publicKey() };
    expect(refusalOf(() => verify(other))).toBe(COSIGN_REFUSED.otherAccount);
    expect(refusalOf(() => verify({ ...responseFor(tx, [b]), network: "mainnet" }))).toBe(
      COSIGN_REFUSED.otherAccount
    );
  });

  test("refuses a signature made for another network", () => {
    const signedOnMainnet = TransactionBuilder.fromXdr(
      buildTx(undefined, undefined, Networks.PUBLIC).toEnvelope().toXDR("base64"),
      Networks.PUBLIC
    );
    signedOnMainnet.sign(b);
    const artifact = {
      ...responseFor(tx, []),
      envelope: envelopeWith(tx.toEnvelope().toXDR("base64"), [...signedOnMainnet.signatures]),
    };
    expect(refusalOf(() => verify(artifact))).toBe(COSIGN_REFUSED.unknownKey);
  });

  test("refuses an unknown key, a hash(x) signer and a zero-weight signer", () => {
    expect(refusalOf(() => verify(responseFor(tx, [Keypair.random()])))).toBe(
      COSIGN_REFUSED.unknownKey
    );
    const preimage = Buffer.alloc(32, 3);
    const hashX = TransactionBuilder.fromXdr(tx.toEnvelope().toXDR("base64"), PASSPHRASE);
    hashX.signHashX(preimage);
    expect(
      refusalOf(() =>
        verify({ ...responseFor(tx, []), envelope: hashX.toEnvelope().toXDR("base64") })
      )
    ).toBe(COSIGN_REFUSED.unknownKey);
    const weightless = SIGNERS.map((s) => (s.key === b.publicKey() ? { ...s, weight: 0 } : s));
    expect(refusalOf(() => verify(responseFor(tx, [b]), weightless))).toBe(
      COSIGN_REFUSED.unknownKey
    );
  });

  test("refuses a signature whose hint names two signers", () => {
    const twin = { key: b.publicKey(), weight: 1, type: "ed25519_public_key" as const };
    const colliding = [...SIGNERS, { ...twin, key: b.publicKey() }];
    expect(refusalOf(() => verify(responseFor(tx, [b]), colliding))).toBe(
      COSIGN_REFUSED.unknownKey
    );
  });

  test("refuses a duplicate key, in the response or already collected", () => {
    expect(refusalOf(() => verify(responseFor(tx, [b, b])))).toBe(COSIGN_REFUSED.duplicate);
    expect(refusalOf(() => verify(responseFor(tx, [master])))).toBe(COSIGN_REFUSED.duplicate);
  });

  test("never takes the response's body, only its signatures", () => {
    const added = verify(responseFor(tx, [b]));
    expect(added.every((s) => s.signature instanceof xdr.DecoratedSignature)).toBe(true);
  });
});

describe("minimalSignatureSet", () => {
  const sig = (key: string, weight: number): PoolSignature => ({
    key,
    weight,
    signature: {} as xdr.DecoratedSignature,
  });
  const keys = (set: PoolSignature[] | null): string[] | null => set?.map((s) => s.key) ?? null;

  test("A(1) held, B(1) arrives, high 2: attaches both", () => {
    expect(keys(minimalSignatureSet([sig("A", 1), sig("B", 1)], 2, []))).toEqual(["A", "B"]);
  });

  test("A(1) held, C(2) arrives, high 2: attaches C alone and prunes A", () => {
    expect(keys(minimalSignatureSet([sig("A", 1), sig("C", 2)], 2, []))).toEqual(["C"]);
  });

  test("A(1) held, B(1) and C(2) arrive, high 2: picks {C} over {A, B}", () => {
    expect(keys(minimalSignatureSet([sig("A", 1), sig("B", 1), sig("C", 2)], 2, []))).toEqual([
      "C",
    ]);
  });

  test("waits while the weight is not met or a mandatory key is missing", () => {
    expect(minimalSignatureSet([sig("M", 1)], 2, ["M"])).toBeNull();
    expect(minimalSignatureSet([sig("B", 1), sig("C", 1)], 2, ["M"])).toBeNull();
  });

  test("keeps the mandatory master key and is minimal around it", () => {
    expect(keys(minimalSignatureSet([sig("M", 1), sig("B", 1), sig("C", 1)], 2, ["M"]))).toEqual([
      "M",
      "B",
    ]);
  });

  test("refuses a set whose master key signature could go unused: M 1, B 2, required 2", () => {
    expect(refusalOf(() => minimalSignatureSet([sig("M", 1), sig("B", 2)], 2, ["M"]))).toBe(
      COSIGN_REFUSED.impossible
    );
  });

  test("refuses when only a set with a signature to spare reaches the weight", () => {
    // M 1, X 2, Y 2, required 4: {M, X} is short and {M, X, Y} can lose M.
    expect(
      refusalOf(() => minimalSignatureSet([sig("M", 1), sig("X", 2), sig("Y", 2)], 4, ["M"]))
    ).toBe(COSIGN_REFUSED.impossible);
  });

  test("every set it returns meets the weight and needs every signature", () => {
    let seed = 11;
    const random = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let run = 0; run < 300; run++) {
      const pool = Array.from({ length: 1 + random(7) }, (_, i) => sig(`K${i}`, 1 + random(4)));
      const required = 1 + random(8);
      const mandatory = random(2) === 0 ? [] : ["K0"];
      let set: PoolSignature[] | null;
      try {
        set = minimalSignatureSet(pool, required, mandatory);
      } catch (err) {
        expect((err as Error).message).toBe(COSIGN_REFUSED.impossible);
        continue;
      }
      if (set === null) continue;
      const total = set.reduce((sum, s) => sum + s.weight, 0);
      expect(total).toBeGreaterThanOrEqual(required);
      for (const s of set) expect(total - s.weight).toBeLessThan(required);
      for (const key of mandatory) expect(set.some((s) => s.key === key)).toBe(true);
    }
  });
});

describe("assertStillSignable", () => {
  const tx = buildTx();
  const merged = (keys: Keypair[]): string => {
    const signed = TransactionBuilder.fromXdr(tx.toEnvelope().toXDR("base64"), PASSPHRASE);
    for (const key of keys) signed.sign(key);
    return signed.toEnvelope().toXDR("base64");
  };
  const check = (envelopeXdr: string, live = LIVE) =>
    assertStillSignable({ envelopeXdr, passphrase: PASSPHRASE, account: ACCOUNT, live });

  test("passes while the live account still matches the attached set", () => {
    expect(() => check(merged([master, b, c]))).not.toThrow();
  });

  test("refuses when a signer was added, removed or reweighted since the build", () => {
    const added = [
      ...SIGNERS,
      { key: Keypair.random().publicKey(), weight: 1, type: "ed25519_public_key" as const },
    ];
    expect(refusalOf(() => check(merged([master, b, c]), { ...LIVE, signers: added }))).toBe(
      COSIGN_REFUSED.signersChanged
    );
    const removed = SIGNERS.filter((s) => s.key !== c.publicKey());
    expect(refusalOf(() => check(merged([master, b, c]), { ...LIVE, signers: removed }))).toBe(
      COSIGN_REFUSED.signersChanged
    );
    const heavier = SIGNERS.map((s) => (s.key === b.publicKey() ? { ...s, weight: 3 } : s));
    expect(refusalOf(() => check(merged([master, b, c]), { ...LIVE, signers: heavier }))).toBe(
      COSIGN_REFUSED.signersChanged
    );
  });

  test("refuses when the thresholds rose or the sequence moved", () => {
    const higher = { ...LIVE, thresholds: { low: 0, med: 3, high: 4 } };
    expect(refusalOf(() => check(merged([master, b, c]), higher))).toBe(
      COSIGN_REFUSED.signersChanged
    );
    expect(refusalOf(() => check(merged([master, b, c]), { ...LIVE, sequence: "101" }))).toBe(
      COSIGN_REFUSED.signersChanged
    );
  });

  test("refuses a set without the master key or with a signature to spare", () => {
    const lower = { ...LIVE, thresholds: { low: 0, med: 2, high: 2 } };
    expect(refusalOf(() => check(merged([master, b, c]), lower))).toBe(
      COSIGN_REFUSED.signersChanged
    );
    expect(refusalOf(() => check(merged([b, c]), lower))).toBe(COSIGN_REFUSED.signersChanged);
  });
});
