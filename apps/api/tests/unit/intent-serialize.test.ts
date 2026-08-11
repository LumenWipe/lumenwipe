import { test, expect } from "bun:test";
import {
  Account,
  Asset,
  Operation,
  TransactionBuilder,
  Networks,
  Keypair,
  StrKey,
  xdr,
} from "@stellar/stellar-sdk";
import { intentFromXdr } from "@/lib/stellar/intent/serialize";

const SRC = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();

function txWith(...ops: ReturnType<typeof Operation.accountMerge>[]): string {
  const account = new Account(SRC, "100");
  const b = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  }).setTimeout(300);
  for (const op of ops) b.addOperation(op);
  return b.build().toEnvelope().toXDR("base64");
}

test("intentFromXdr normalizes change_trust and account_merge", () => {
  const xdr = txWith(
    Operation.changeTrust({ asset: new Asset("USDC", ISSUER), limit: "0" }),
    Operation.accountMerge({ destination: DEST })
  );
  const intent = intentFromXdr(xdr, Networks.TESTNET);

  expect(intent.source).toBe(SRC);
  expect(intent.operations).toContainEqual({
    type: "change_trust",
    asset: `USDC:${ISSUER}`,
    limit: "0.0000000",
  });
  expect(intent.operations).toContainEqual({ type: "account_merge", destination: DEST });
  expect(intent.guarantees.mergeDestination).toBe(DEST);
});

test("intentFromXdr captures the conversion floor and self-payment destination", () => {
  const xdr = txWith(
    Operation.pathPaymentStrictSend({
      sendAsset: new Asset("USDC", ISSUER),
      sendAmount: "120.50",
      destination: SRC,
      destAsset: Asset.native(),
      destMin: "118.20",
      path: [],
    }),
    Operation.changeTrust({ asset: new Asset("USDC", ISSUER), limit: "0" }),
    Operation.accountMerge({ destination: DEST })
  );
  const intent = intentFromXdr(xdr, Networks.TESTNET);

  expect(intent.operations[0]).toEqual({
    type: "path_payment_strict_send",
    sendAsset: `USDC:${ISSUER}`,
    sendAmount: "120.5000000",
    destination: SRC,
    destAsset: "native",
    destMin: "118.2000000",
    path: [],
  });
  expect(intent.guarantees.minXlmFromConversions).toBe("118.2000000");
  expect(intent.guarantees.paymentsOnlyTo).toContain(SRC);
  expect(intent.guarantees.mergeDestination).toBe(DEST);
});

test("intentFromXdr returns null merge destination when there is no merge", () => {
  const xdr = txWith(Operation.changeTrust({ asset: new Asset("USDC", ISSUER), limit: "0" }));
  const intent = intentFromXdr(xdr, Networks.TESTNET);
  expect(intent.guarantees.mergeDestination).toBeNull();
  expect(intent.guarantees.minXlmFromConversions).toBeNull();
});

test("intentFromXdr normalizes revokeAccountSponsorship operation", () => {
  const sponsor = Keypair.random().publicKey();
  const xdr = txWith(Operation.revokeAccountSponsorship({ account: sponsor }));
  const intent = intentFromXdr(xdr, Networks.TESTNET);

  expect(intent.operations).toContainEqual({
    type: "revoke_sponsorship",
    entryKind: "account",
    owner: sponsor,
  });
});

test("intentFromXdr normalizes all revoke-sponsorship operation types", () => {
  const account = Keypair.random().publicKey();
  const seller = Keypair.random().publicKey();
  const signer = Keypair.random().publicKey();

  const xdr = txWith(
    Operation.revokeAccountSponsorship({ account }),
    Operation.revokeTrustlineSponsorship({ account, asset: new Asset("USDC", ISSUER) }),
    Operation.revokeOfferSponsorship({ seller, offerId: "12345" }),
    Operation.revokeDataSponsorship({ account, name: "test" }),
    Operation.revokeSignerSponsorship({ account, signer: { ed25519PublicKey: signer } })
  );
  const intent = intentFromXdr(xdr, Networks.TESTNET);

  expect(intent.operations).toContainEqual({
    type: "revoke_sponsorship",
    entryKind: "account",
    owner: account,
  });
  expect(intent.operations).toContainEqual({
    type: "revoke_sponsorship",
    entryKind: "trustline",
    owner: account,
  });
  expect(intent.operations).toContainEqual({
    type: "revoke_sponsorship",
    entryKind: "offer",
    owner: seller,
  });
  expect(intent.operations).toContainEqual({
    type: "revoke_sponsorship",
    entryKind: "data_entry",
    owner: account,
  });
  expect(intent.operations).toContainEqual({
    type: "revoke_sponsorship",
    entryKind: "signer",
    owner: account,
  });
});

test("intentFromXdr decodes an ed25519 signer removal with its type and key", () => {
  const signerKey = Keypair.random().publicKey();
  const txXdr = txWith(Operation.setOptions({ signer: { ed25519PublicKey: signerKey, weight: 0 } }));
  const intent = intentFromXdr(txXdr, Networks.TESTNET);
  expect(intent.operations).toContainEqual({
    type: "set_options",
    signer: { type: "ed25519_public_key", key: signerKey, weight: 0 },
    masterWeight: null,
    lowThreshold: null,
    medThreshold: null,
    highThreshold: null,
  });
});

test("intentFromXdr decodes a hash(x) signer removal, re-encoding the raw hash to strkey", () => {
  const rawHash = Keypair.random().rawPublicKey();
  const txXdr = txWith(Operation.setOptions({ signer: { sha256Hash: rawHash, weight: 0 } }));
  const intent = intentFromXdr(txXdr, Networks.TESTNET);
  expect(intent.operations).toContainEqual({
    type: "set_options",
    signer: { type: "hash_x", key: StrKey.encodeSha256Hash(rawHash), weight: 0 },
    masterWeight: null,
    lowThreshold: null,
    medThreshold: null,
    highThreshold: null,
  });
});

test("intentFromXdr decodes a pre-auth-tx signer removal, re-encoding the raw hash to strkey", () => {
  const rawHash = Keypair.random().rawPublicKey();
  const txXdr = txWith(Operation.setOptions({ signer: { preAuthTx: rawHash, weight: 0 } }));
  const intent = intentFromXdr(txXdr, Networks.TESTNET);
  expect(intent.operations).toContainEqual({
    type: "set_options",
    signer: { type: "preauth_tx", key: StrKey.encodePreAuthTx(rawHash), weight: 0 },
    masterWeight: null,
    lowThreshold: null,
    medThreshold: null,
    highThreshold: null,
  });
});

test("intentFromXdr decodes an ed25519 signed-payload (CAP-40) signer removal", () => {
  const payloadXdr = new xdr.SignerKeyEd25519SignedPayload({
    ed25519: Keypair.random().rawPublicKey(),
    payload: Buffer.from("cafebabe", "hex"),
  }).toXDR();
  const signedPayloadKey = StrKey.encodeSignedPayload(payloadXdr);
  const txXdr = txWith(
    Operation.setOptions({ signer: { ed25519SignedPayload: signedPayloadKey, weight: 0 } })
  );
  const intent = intentFromXdr(txXdr, Networks.TESTNET);
  expect(intent.operations).toContainEqual({
    type: "set_options",
    signer: { type: "ed25519_signed_payload", key: signedPayloadKey, weight: 0 },
    masterWeight: null,
    lowThreshold: null,
    medThreshold: null,
    highThreshold: null,
  });
});

test("intentFromXdr decodes a set_options op with no signer field as signer: null", () => {
  const txXdr = txWith(Operation.setOptions({ lowThreshold: 0, medThreshold: 1, highThreshold: 1 }));
  const intent = intentFromXdr(txXdr, Networks.TESTNET);
  expect(intent.operations).toContainEqual({
    type: "set_options",
    signer: null,
    masterWeight: null,
    lowThreshold: 0,
    medThreshold: 1,
    highThreshold: 1,
  });
});
