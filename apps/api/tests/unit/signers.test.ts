import { test, expect } from "bun:test";
import { Account, Keypair, Operation, StrKey, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { buildNormalizeSignersTx, signerNormalizationOps } from "@/lib/stellar/tx-builder/signers";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import { BASE_FEE_STROOPS } from "@/config/constants";
import type { AccountSigner } from "@lumenwipe/types";

const MASTER = Keypair.random().publicKey();
const SIGNER_KP = Keypair.random();

test("signerNormalizationOps > removes an ed25519_public_key signer at weight 0", () => {
  const signers: AccountSigner[] = [
    { key: MASTER, weight: 1, type: "ed25519_public_key" },
    { key: SIGNER_KP.publicKey(), weight: 1, type: "ed25519_public_key" },
  ];
  const ops = signerNormalizationOps(signers, MASTER);
  const removal = Operation.fromXDRObject(ops[0]!);
  expect(removal.type).toBe("setOptions");
  // @ts-expect-error - narrow for the assertion only
  expect(removal.signer.ed25519PublicKey).toBe(SIGNER_KP.publicKey());
  // @ts-expect-error - narrow for the assertion only
  expect(removal.signer.weight).toBe(0);
});

test("signerNormalizationOps > removes a hash_x signer at weight 0", () => {
  const hashXKey = StrKey.encodeSha256Hash(SIGNER_KP.rawPublicKey());
  const signers: AccountSigner[] = [
    { key: MASTER, weight: 1, type: "ed25519_public_key" },
    { key: hashXKey, weight: 1, type: "hash_x" },
  ];
  const ops = signerNormalizationOps(signers, MASTER);
  const removal = Operation.fromXDRObject(ops[0]!);
  // @ts-expect-error - narrow for the assertion only
  expect(removal.signer.sha256Hash).toEqual(SIGNER_KP.rawPublicKey());
  // @ts-expect-error - narrow for the assertion only
  expect(removal.signer.weight).toBe(0);
});

test("signerNormalizationOps > removes a preauth_tx signer at weight 0", () => {
  const preAuthKey = StrKey.encodePreAuthTx(SIGNER_KP.rawPublicKey());
  const signers: AccountSigner[] = [
    { key: MASTER, weight: 1, type: "ed25519_public_key" },
    { key: preAuthKey, weight: 1, type: "preauth_tx" },
  ];
  const ops = signerNormalizationOps(signers, MASTER);
  const removal = Operation.fromXDRObject(ops[0]!);
  // @ts-expect-error - narrow for the assertion only
  expect(removal.signer.preAuthTx).toEqual(SIGNER_KP.rawPublicKey());
  // @ts-expect-error - narrow for the assertion only
  expect(removal.signer.weight).toBe(0);
});

test("signerNormalizationOps > removes an ed25519_signed_payload signer at weight 0", () => {
  const payloadKey = StrKey.encodeSignedPayload(
    new xdr.SignerKeyEd25519SignedPayload({
      ed25519: SIGNER_KP.rawPublicKey(),
      payload: Buffer.from("cafebabe", "hex"),
    }).toXDR()
  );
  const signers: AccountSigner[] = [
    { key: MASTER, weight: 1, type: "ed25519_public_key" },
    { key: payloadKey, weight: 1, type: "ed25519_signed_payload" },
  ];
  const ops = signerNormalizationOps(signers, MASTER);
  const removal = Operation.fromXDRObject(ops[0]!);
  // @ts-expect-error - narrow for the assertion only
  expect(removal.signer.ed25519SignedPayload).toBe(payloadKey);
  // @ts-expect-error - narrow for the assertion only
  expect(removal.signer.weight).toBe(0);
});

test("signerNormalizationOps > a signer of a type the builder cannot construct a removal for is skipped, not pushed as null", () => {
  // AccountSigner's type is a closed 4-member union in the shared types package, so this can
  // only happen via a value the type system doesn't actually allow through - the same defensive
  // case signerRemovalOp's trailing `return null` exists for (see its own comment: "skip, don't
  // fail the batch"). Bypassing the type system here is the only way to exercise that path.
  const bogus = {
    key: "not-a-real-key",
    weight: 1,
    type: "unknown_type",
  } as unknown as AccountSigner;
  const signers: AccountSigner[] = [{ key: MASTER, weight: 1, type: "ed25519_public_key" }, bogus];
  const ops = signerNormalizationOps(signers, MASTER);
  // Just the threshold reset - the bogus signer contributes no op, and no null slips into the array.
  expect(ops).toHaveLength(1);
  expect(ops.every((op) => op !== null)).toBe(true);
});

test("signerNormalizationOps > skips the master key itself", () => {
  const signers: AccountSigner[] = [{ key: MASTER, weight: 1, type: "ed25519_public_key" }];
  const ops = signerNormalizationOps(signers, MASTER);
  // Just the threshold reset, no removal for the master key.
  expect(ops).toHaveLength(1);
});

test("signerNormalizationOps > resets thresholds to 0/1/1 as the last op", () => {
  const signers: AccountSigner[] = [{ key: MASTER, weight: 1, type: "ed25519_public_key" }];
  const ops = signerNormalizationOps(signers, MASTER);
  const reset = Operation.fromXDRObject(ops[ops.length - 1]!);
  expect(reset.type).toBe("setOptions");
  // @ts-expect-error - narrow for the assertion only
  expect(reset.lowThreshold).toBe(0);
  // @ts-expect-error - narrow for the assertion only
  expect(reset.medThreshold).toBe(1);
  // @ts-expect-error - narrow for the assertion only
  expect(reset.highThreshold).toBe(1);
});

test("buildNormalizeSignersTx > n ops -> fee scales linearly, envelope decodes", () => {
  const account = new Account(MASTER, "100");
  const xdrStr = buildNormalizeSignersTx(
    account,
    [
      { key: MASTER, weight: 1, type: "ed25519_public_key" },
      { key: SIGNER_KP.publicKey(), weight: 1, type: "ed25519_public_key" },
    ],
    "testnet"
  );
  const tx = TransactionBuilder.fromXDR(xdrStr, NETWORK_PASSPHRASES.testnet);
  // 1 removal + 1 threshold reset = 2 ops.
  expect(tx.operations).toHaveLength(2);
  expect(tx.operations.every((op) => op.type === "setOptions")).toBe(true);
  expect(Number(tx.fee)).toBe(BASE_FEE_STROOPS * 2);
});
