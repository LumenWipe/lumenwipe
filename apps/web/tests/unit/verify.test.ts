import { test, expect } from "bun:test";
import {
  Account,
  Asset,
  hash,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { assertCloseIntent, VerificationError, type CloseExpectation } from "@/lib/stellar/verify";
import { intentFromXdr } from "@/lib/stellar/intent/serialize";
import type { IntentOperation, TxIntent } from "@/types/close-api";
import type { AccountSigner } from "@/types/account";

const SRC = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const MED = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const ATTACKER = Keypair.random().publicKey();
const REMOVED_SIGNER = Keypair.random().publicKey();

function expectation(over: Partial<CloseExpectation> = {}): CloseExpectation {
  return {
    source: SRC,
    destination: DEST,
    memo: null,
    memoRequired: false,
    memoType: null,
    claimTrustlineAssets: [],
    accountSigners: [
      { key: SRC, weight: 1, type: "ed25519_public_key" },
      { key: REMOVED_SIGNER, weight: 1, type: "ed25519_public_key" },
    ],
    accountThresholds: { low: 0, med: 1, high: 1 },
    ...over,
  };
}

function intent(over: Partial<TxIntent> = {}): TxIntent {
  return {
    summary: "",
    source: SRC,
    fee: "100",
    memo: null,
    memoType: null,
    guarantees: { mergeDestination: DEST, paymentsOnlyTo: [], minXlmFromConversions: null },
    operations: [],
    ...over,
  };
}

const conversion = (destination = SRC, destAsset = "native", destMin = "9"): IntentOperation => ({
  source: SRC,
  type: "path_payment_strict_send",
  sendAsset: `USDC:${ISSUER}`,
  sendAmount: "10",
  destination,
  destAsset,
  destMin,
  path: [],
});
const merge = (destination: string, source = SRC): IntentOperation => ({
  source,
  type: "account_merge",
  destination,
});
const payment = (
  destination: string,
  asset = `USDC:${ISSUER}`,
  source = SRC
): IntentOperation => ({
  source,
  type: "payment",
  destination,
  asset,
  amount: "5",
});
const setOptions = (
  over: Partial<Extract<IntentOperation, { type: "set_options" }>> = {}
): IntentOperation => ({
  source: SRC,
  type: "set_options",
  signer: { type: "ed25519_public_key", key: REMOVED_SIGNER, weight: 0 },
  masterWeight: null,
  lowThreshold: null,
  medThreshold: null,
  highThreshold: null,
  ...over,
});

// ─── Happy paths (pure) ──────────────────────────────────────────────────────

test("a well-formed direct close passes", () => {
  const i = intent({
    guarantees: {
      mergeDestination: DEST,
      paymentsOnlyTo: [SRC, ISSUER],
      minXlmFromConversions: "9",
    },
    operations: [setOptions(), conversion(), payment(ISSUER), merge(DEST)],
  });
  expect(() => assertCloseIntent(i, expectation())).not.toThrow();
});

test("a well-formed mediator close passes (merge to mediator, forward to destination, memo)", () => {
  const i = intent({
    memo: "deposit-1",
    memoType: "text",
    guarantees: { mergeDestination: MED, paymentsOnlyTo: [DEST], minXlmFromConversions: null },
    operations: [merge(MED), payment(DEST, "native", MED)],
  });
  expect(() =>
    assertCloseIntent(
      i,
      expectation({ memo: "deposit-1", memoRequired: true, memoType: "text" })
    )
  ).not.toThrow();
});

// ─── Round-trip through intentFromXdr (catches decode-shape bugs) ─────────────

function buildXdr(ops: xdr.Operation[]): string {
  const builder = new TransactionBuilder(new Account(SRC, "100"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  }).setTimeout(300);
  for (const op of ops) builder.addOperation(op);
  return builder.build().toEnvelope().toXDR("base64");
}

test("a real close that removes a trustline and cancels an offer passes (zero decodes as 0.0000000)", () => {
  const xdr = buildXdr([
    Operation.manageSellOffer({
      selling: new Asset("USDC", ISSUER),
      buying: Asset.native(),
      amount: "0",
      price: "1",
      offerId: "12345",
    }),
    Operation.changeTrust({ asset: new Asset("USDC", ISSUER), limit: "0" }),
    Operation.accountMerge({ destination: DEST }),
  ]);
  const i = intentFromXdr(xdr, Networks.TESTNET);
  expect(() => assertCloseIntent(i, expectation())).not.toThrow();
});

test("rejects a real transaction carrying an unrecognized operation", () => {
  const xdr = buildXdr([
    Operation.bumpSequence({ bumpTo: "999" }),
    Operation.accountMerge({ destination: DEST }),
  ]);
  const i = intentFromXdr(xdr, Networks.TESTNET);
  expect(() => assertCloseIntent(i, expectation())).toThrow(VerificationError);
});

// ─── Tampering is caught (pure) ──────────────────────────────────────────────

test("rejects a merge to an unexpected destination", () => {
  const i = intent({
    guarantees: { mergeDestination: ATTACKER, paymentsOnlyTo: [], minXlmFromConversions: null },
  });
  expect(() => assertCloseIntent(i, expectation())).toThrow(VerificationError);
});

test("rejects a native-XLM payment to a trustline issuer", () => {
  const i = intent({ operations: [payment(ISSUER, "native")] });
  expect(() => assertCloseIntent(i, expectation())).toThrow(VerificationError);
});

test("rejects a payment to an unexpected address", () => {
  const i = intent({ operations: [payment(ATTACKER)] });
  expect(() => assertCloseIntent(i, expectation())).toThrow(VerificationError);
});

test("rejects a conversion that pays out of the account", () => {
  const i = intent({ operations: [conversion(ATTACKER)] });
  expect(() => assertCloseIntent(i, expectation())).toThrow(VerificationError);
});

test("rejects a conversion with no minimum floor", () => {
  const i = intent({ operations: [conversion(SRC, "native", "0")] });
  expect(() => assertCloseIntent(i, expectation())).toThrow(VerificationError);
});

test("rejects a trustline that is created/raised instead of removed", () => {
  const i = intent({
    operations: [{ source: SRC, type: "change_trust", asset: `USDC:${ISSUER}`, limit: "100" }],
  });
  expect(() => assertCloseIntent(i, expectation())).toThrow(VerificationError);
});

test("allows a raised trustline for an asset the user chose to claim-remediate", () => {
  const asset = `USDC:${ISSUER}`;
  const i = intent({ operations: [{ source: SRC, type: "change_trust", asset, limit: "100" }] });
  expect(() => assertCloseIntent(i, expectation({ claimTrustlineAssets: [asset] }))).not.toThrow();
});

test("rejects a raised trustline for an asset not in the user's own claim-remediation choice", () => {
  const asset = `USDC:${ISSUER}`;
  const i = intent({ operations: [{ source: SRC, type: "change_trust", asset, limit: "100" }] });
  expect(() =>
    assertCloseIntent(i, expectation({ claimTrustlineAssets: [`EURC:${ISSUER}`] }))
  ).toThrow(VerificationError);
});

test("rejects a data entry that is written instead of removed", () => {
  const i = intent({ operations: [{ source: SRC, type: "manage_data", name: "k", value: "dmFsdWU=" }] });
  expect(() => assertCloseIntent(i, expectation())).toThrow(VerificationError);
});

test("rejects an offer that is created instead of cancelled", () => {
  const i = intent({ operations: [{ source: SRC, type: "manage_sell_offer", offerId: "0", amount: "50" }] });
  expect(() => assertCloseIntent(i, expectation())).toThrow(VerificationError);
});

test("rejects a set_options that adds or empowers a signer", () => {
  const i = intent({
    operations: [
      setOptions({ signer: { type: "ed25519_public_key", key: REMOVED_SIGNER, weight: 1 } }),
    ],
  });
  expect(() => assertCloseIntent(i, expectation())).toThrow(VerificationError);
});

test("rejects a set_options signer removal for a key that is not on the account", () => {
  const i = intent({
    operations: [setOptions({ signer: { type: "ed25519_public_key", key: ATTACKER, weight: 0 } })],
  });
  expect(() => assertCloseIntent(i, expectation())).toThrow(VerificationError);
});

test("rejects a signer removal when accountSigners is empty (fail-closed default)", () => {
  // Pins the fail-closed default `useCloseExecution.ts` relies on
  // (`accountSigners: accountState?.signers ?? []`): an empty accountSigners must never be
  // read as "unknown, allow" for an otherwise legitimate-shaped removal.
  const i = intent({
    operations: [
      setOptions({ signer: { type: "ed25519_public_key", key: REMOVED_SIGNER, weight: 0 } }),
    ],
  });
  expect(() => assertCloseIntent(i, expectation({ accountSigners: [] }))).toThrow(
    VerificationError
  );
});

test("rejects a signer removal whose key matches a known signer but whose type does not", () => {
  // The match must require both `key` AND `type`, not `key` alone.
  const i = intent({
    operations: [setOptions({ signer: { type: "hash_x", key: REMOVED_SIGNER, weight: 0 } })],
  });
  expect(() => assertCloseIntent(i, expectation())).toThrow(VerificationError);
});

test("allows a set_options that only touches thresholds (no signer field)", () => {
  const i = intent({ operations: [setOptions({ signer: null, highThreshold: 1 })] });
  expect(() => assertCloseIntent(i, expectation())).not.toThrow();
});

test("a real close removing all four signer types passes when each is genuinely on the account", () => {
  const hashXRaw = Keypair.random().rawPublicKey();
  const preAuthRaw = Keypair.random().rawPublicKey();
  const signedPayloadXdr = new xdr.SignerKeyEd25519SignedPayload({
    ed25519: Keypair.random().rawPublicKey(),
    payload: Buffer.from("cafebabe", "hex"),
  }).toXDR();
  const signedPayloadKey = StrKey.encodeSignedPayload(signedPayloadXdr);
  const hashXKey = StrKey.encodeSha256Hash(hashXRaw);
  const preAuthKey = StrKey.encodePreAuthTx(preAuthRaw);

  const txXdr = buildXdr([
    Operation.setOptions({ signer: { ed25519PublicKey: REMOVED_SIGNER, weight: 0 } }),
    Operation.setOptions({ signer: { sha256Hash: hashXRaw, weight: 0 } }),
    Operation.setOptions({ signer: { preAuthTx: preAuthRaw, weight: 0 } }),
    Operation.setOptions({ signer: { ed25519SignedPayload: signedPayloadKey, weight: 0 } }),
    Operation.accountMerge({ destination: DEST }),
  ]);
  const i = intentFromXdr(txXdr, Networks.TESTNET);
  expect(() =>
    assertCloseIntent(
      i,
      expectation({
        accountSigners: [
          { key: SRC, weight: 1, type: "ed25519_public_key" },
          { key: REMOVED_SIGNER, weight: 1, type: "ed25519_public_key" },
          { key: hashXKey, weight: 1, type: "hash_x" },
          { key: preAuthKey, weight: 1, type: "preauth_tx" },
          { key: signedPayloadKey, weight: 1, type: "ed25519_signed_payload" },
        ],
      })
    )
  ).not.toThrow();
});

test("rejects a hash(x) signer removal for a hash that is not a known signer", () => {
  const hashXRaw = Keypair.random().rawPublicKey();
  const txXdr = buildXdr([Operation.setOptions({ signer: { sha256Hash: hashXRaw, weight: 0 } })]);
  const i = intentFromXdr(txXdr, Networks.TESTNET);
  expect(() => assertCloseIntent(i, expectation())).toThrow(VerificationError);
});

// ─── Multisig: a hash(x) decorated signature needs no special-casing (#101) ──

test("verifyCloseTransaction still approves a transaction whose only change is an added hash(x) signature", () => {
  const preimage = Buffer.from("deadbeef", "hex");
  const hashXKey = StrKey.encodeSha256Hash(hash(preimage));

  const unsignedXdr = buildXdr([
    Operation.setOptions({ signer: { sha256Hash: hash(preimage), weight: 0 } }),
    Operation.accountMerge({ destination: DEST }),
  ]);
  const accountSigners: AccountSigner[] = [
    { key: SRC, weight: 1, type: "ed25519_public_key" },
    { key: hashXKey, weight: 1, type: "hash_x" },
  ];

  const unsignedIntent = intentFromXdr(unsignedXdr, Networks.TESTNET);
  expect(() => assertCloseIntent(unsignedIntent, expectation({ accountSigners }))).not.toThrow();

  // Apply the hash(x) contribution exactly as HashXPreimageSigner does - the transaction
  // body is untouched, only a decorated signature is appended.
  const built = TransactionBuilder.fromXDR(unsignedXdr, Networks.TESTNET);
  built.signHashX(preimage);
  const signedXdr = built.toEnvelope().toXDR("base64");

  const signedIntent = intentFromXdr(signedXdr, Networks.TESTNET);
  expect(signedIntent).toEqual(unsignedIntent);
  expect(() => assertCloseIntent(signedIntent, expectation({ accountSigners }))).not.toThrow();
});

test("rejects a set_options that disables the master key", () => {
  const i = intent({ operations: [setOptions({ masterWeight: 0 })] });
  expect(() => assertCloseIntent(i, expectation())).toThrow(VerificationError);
});

test("rejects a set_options that raises a threshold", () => {
  const i = intent({ operations: [setOptions({ highThreshold: 2 })] });
  expect(() => assertCloseIntent(i, expectation())).toThrow(VerificationError);
});

test("rejects a memo the user did not set", () => {
  const i = intent({ memo: "not-mine" });
  expect(() => assertCloseIntent(i, expectation({ memo: "mine" }))).toThrow(VerificationError);
});

test("rejects a missing memo when the destination requires one (even if the user left it blank)", () => {
  const i = intent({ memo: null });
  expect(() =>
    assertCloseIntent(i, expectation({ memo: null, memoRequired: true, memoType: "id" }))
  ).toThrow(VerificationError);
});

test("rejects a memo of the wrong type for the destination", () => {
  const i = intent({ memo: "12345", memoType: "text" });
  expect(() =>
    assertCloseIntent(i, expectation({ memo: "12345", memoRequired: true, memoType: "id" }))
  ).toThrow(VerificationError);
});

test("rejects a transaction for a different account", () => {
  const i = intent({ source: ATTACKER });
  expect(() => assertCloseIntent(i, expectation())).toThrow(VerificationError);
});

// #102: pre-auth-tx signer support. The manual pre-auth-tx path (useCloseExecution's
// submitPreAuthTransaction) runs a user-supplied transaction - never built by the API - through
// this exact same assertCloseIntent, since every check here is a self-contained structural
// assertion (never a comparison against a per-step "expected operation list"). These two tests
// prove the checks the issue calls out by name still reject a hostile/malformed pasted
// transaction, exactly as they would for an API-built one.
test("rejects a pasted pre-auth-tx transaction that merges to an unexpected destination", () => {
  const i = intent({
    operations: [merge(ATTACKER)],
    guarantees: { mergeDestination: ATTACKER, paymentsOnlyTo: [], minXlmFromConversions: null },
  });
  expect(() => assertCloseIntent(i, expectation())).toThrow(VerificationError);
  expect(() => assertCloseIntent(i, expectation())).toThrow(/did not choose/i);
});

test("rejects a pasted pre-auth-tx transaction carrying an unrecognized operation", () => {
  const i = intent({ operations: [{ source: SRC, type: "unknown" }] });
  expect(() => assertCloseIntent(i, expectation())).toThrow(VerificationError);
  expect(() => assertCloseIntent(i, expectation())).toThrow(/unrecognized operation/i);
});

// ─── the mediated close is accepted on structure, not on identity (#116) ─────

// The point of the change: no address is configured anywhere, and the close still verifies.
// The intermediary can be rotated without telling any client.
test("a mediated close passes without the client knowing the intermediary's address", () => {
  const anyIntermediary = Keypair.random().publicKey();
  const i = intent({
    guarantees: {
      mergeDestination: anyIntermediary,
      paymentsOnlyTo: [DEST],
      minXlmFromConversions: null,
    },
    operations: [merge(anyIntermediary), payment(DEST, "native", anyIntermediary)],
  });
  expect(() => assertCloseIntent(i, expectation())).not.toThrow();
});

// The load-bearing assertion. Merge into one account, forward from another: the account that
// received the balance is under no obligation to pass it on, so it keeps it. Pinning the
// intermediary's address would have waved this through - the merge destination is "correct".
test("rejects a forward sent by an account other than the one the merge paid into", () => {
  const intermediary = Keypair.random().publicKey();
  const i = intent({
    guarantees: { mergeDestination: intermediary, paymentsOnlyTo: [DEST], minXlmFromConversions: null },
    operations: [merge(intermediary), payment(DEST, "native", ATTACKER)],
  });
  expect(() => assertCloseIntent(i, expectation())).toThrow(/is the one passing them on/);
});

test("rejects a merge to an unexpected address with no forward at all", () => {
  const i = intent({
    guarantees: { mergeDestination: ATTACKER, paymentsOnlyTo: [], minXlmFromConversions: null },
    operations: [merge(ATTACKER)],
  });
  expect(() => assertCloseIntent(i, expectation())).toThrow(/did not choose/);
});

test("rejects a mediated close carrying an extra operation", () => {
  const intermediary = Keypair.random().publicKey();
  const i = intent({
    guarantees: { mergeDestination: intermediary, paymentsOnlyTo: [DEST], minXlmFromConversions: null },
    operations: [merge(intermediary), payment(DEST, "native", intermediary), setOptions()],
  });
  expect(() => assertCloseIntent(i, expectation())).toThrow(VerificationError);
});

test("rejects a forward to an address the user did not type", () => {
  const intermediary = Keypair.random().publicKey();
  const i = intent({
    guarantees: { mergeDestination: intermediary, paymentsOnlyTo: [ATTACKER], minXlmFromConversions: null },
    operations: [merge(intermediary), payment(ATTACKER, "native", intermediary)],
  });
  expect(() => assertCloseIntent(i, expectation())).toThrow(/unexpected address/);
});

test("rejects a forward that is not XLM", () => {
  const intermediary = Keypair.random().publicKey();
  const i = intent({
    guarantees: { mergeDestination: intermediary, paymentsOnlyTo: [DEST], minXlmFromConversions: null },
    operations: [merge(intermediary), payment(DEST, `USDC:${ISSUER}`, intermediary)],
  });
  expect(() => assertCloseIntent(i, expectation())).toThrow(VerificationError);
});

// The merge must be sent by the account being closed - otherwise some other account is being
// drained and the user's own balance never moves.
test("rejects a merge not sent by the account being closed", () => {
  const intermediary = Keypair.random().publicKey();
  const i = intent({
    guarantees: { mergeDestination: intermediary, paymentsOnlyTo: [DEST], minXlmFromConversions: null },
    operations: [merge(intermediary, ATTACKER), payment(DEST, "native", intermediary)],
  });
  expect(() => assertCloseIntent(i, expectation())).toThrow(/not sent by the account being closed/);
});

// Reversing the order breaks the hand-off: the forward would run before the balance arrives.
test("rejects the two operations in the wrong order", () => {
  const intermediary = Keypair.random().publicKey();
  const i = intent({
    guarantees: { mergeDestination: intermediary, paymentsOnlyTo: [DEST], minXlmFromConversions: null },
    operations: [payment(DEST, "native", intermediary), merge(intermediary)],
  });
  expect(() => assertCloseIntent(i, expectation())).toThrow(VerificationError);
});
