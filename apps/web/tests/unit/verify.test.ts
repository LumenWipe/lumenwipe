import { test, expect } from "bun:test";
import {
  Account,
  Asset,
  hash,
  Keypair,
  Memo,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import {
  assertCloseIntent,
  verifyCloseTransaction,
  VerificationError,
  type CloseExpectation,
} from "@/lib/stellar/verify";
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
    mediatorRequired: false,
    nativeBalance: "100.0000000",
    memo: null,
    memoRequired: false,
    memoType: null,
    claimTrustlineAssets: [],
    transfers: {},
    exitContracts: [POOL],
    heldTokenContracts: [XLM_SAC],
    positionTokenContracts: [],
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
  source = SRC,
  amount = "5"
): IntentOperation => ({
  source,
  type: "payment",
  destination,
  asset,
  amount,
});

// A mediated close the client would accept: the balance it observed leaves the intermediary
// whole. `BALANCE` is what `expectation()` reports as the account's native balance.
const BALANCE = "100.0000000";
const mediated = (
  intermediary: string,
  over: Partial<{ forwardSource: string; forwardTo: string; amount: string }> = {}
) => ({
  guarantees: {
    mergeDestination: intermediary,
    paymentsOnlyTo: [over.forwardTo ?? DEST],
    minXlmFromConversions: null,
  },
  operations: [
    merge(intermediary),
    payment(
      over.forwardTo ?? DEST,
      "native",
      over.forwardSource ?? intermediary,
      over.amount ?? BALANCE
    ),
  ],
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
  homeDomain: null,
  setFlags: null,
  clearFlags: null,
  inflationDest: null,
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
    operations: [merge(MED), payment(DEST, "native", MED, "100.0000000")],
  });
  expect(() =>
    assertCloseIntent(
      i,
      expectation({
        memo: "deposit-1",
        memoRequired: true,
        memoType: "text",
        mediatorRequired: true,
        nativeBalance: "100.0000000",
      })
    )
  ).not.toThrow();
});

test("a VerificationError carries the class's own name, not the generic Error name", () => {
  try {
    assertCloseIntent(intent({ source: ATTACKER }), expectation());
    throw new Error("expected assertCloseIntent to throw");
  } catch (e) {
    expect(e).toBeInstanceOf(VerificationError);
    expect((e as VerificationError).name).toBe("VerificationError");
  }
});

// ─── Round-trip through intentFromXdr (catches decode-shape bugs) ─────────────

function buildXdr(ops: xdr.Operation[], memo?: Memo): string {
  const builder = new TransactionBuilder(new Account(SRC, "100"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  }).setTimeout(300);
  for (const op of ops) builder.addOperation(op);
  if (memo) builder.addMemo(memo);
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
    operations: [merge(ATTACKER)],
  });
  expect(() => assertCloseIntent(i, expectation())).toThrow(/did not choose/);
});

test("rejects a native-XLM payment to a trustline issuer", () => {
  const i = intent({ operations: [payment(ISSUER, "native")] });
  expect(() => assertCloseIntent(i, expectation())).toThrow(VerificationError);
});

test("rejects a payment to an unexpected address", () => {
  const i = intent({ operations: [payment(ATTACKER)] });
  expect(() => assertCloseIntent(i, expectation())).toThrow(/unexpected address/);
});

test("rejects a conversion that pays out of the account", () => {
  const i = intent({ operations: [conversion(ATTACKER)] });
  expect(() => assertCloseIntent(i, expectation())).toThrow(/send funds out of your account/);
});

test("rejects a conversion that would not settle in XLM", () => {
  const i = intent({ operations: [conversion(SRC, `USDC:${ISSUER}`, "9")] });
  expect(() => assertCloseIntent(i, expectation())).toThrow(/would not settle in XLM/);
});

test("rejects a conversion with no minimum floor", () => {
  const i = intent({ operations: [conversion(SRC, "native", "0")] });
  expect(() => assertCloseIntent(i, expectation())).toThrow(/no minimum-received floor/);
});

test("rejects a trustline that is created/raised instead of removed", () => {
  const i = intent({
    operations: [{ source: SRC, type: "change_trust", asset: `USDC:${ISSUER}`, limit: "100" }],
  });
  expect(() => assertCloseIntent(i, expectation())).toThrow(/created or raised, not removed/);
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
  const i = intent({
    operations: [{ source: SRC, type: "manage_data", name: "k", value: "dmFsdWU=" }],
  });
  expect(() => assertCloseIntent(i, expectation())).toThrow(/would be written, not removed/);
});

test("allows a data entry deletion", () => {
  const i = intent({ operations: [{ source: SRC, type: "manage_data", name: "k", value: null }] });
  expect(() => assertCloseIntent(i, expectation())).not.toThrow();
});

test("rejects an offer that is created instead of cancelled", () => {
  const i = intent({
    operations: [{ source: SRC, type: "manage_sell_offer", offerId: "0", amount: "50" }],
  });
  expect(() => assertCloseIntent(i, expectation())).toThrow(/created, not cancelled/);
});

test("rejects a set_options that adds or empowers a signer", () => {
  const i = intent({
    operations: [
      setOptions({ signer: { type: "ed25519_public_key", key: REMOVED_SIGNER, weight: 1 } }),
    ],
  });
  expect(() => assertCloseIntent(i, expectation())).toThrow(/signer would be added or empowered/);
});

test("rejects a set_options signer removal for a key that is not on the account", () => {
  const i = intent({
    operations: [setOptions({ signer: { type: "ed25519_public_key", key: ATTACKER, weight: 0 } })],
  });
  expect(() => assertCloseIntent(i, expectation())).toThrow(/wasn't on your account/);
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
  expect(() => assertCloseIntent(i, expectation())).toThrow(/master key would be disabled/);
});

test("rejects a set_options that raises the high threshold", () => {
  const i = intent({ operations: [setOptions({ signer: null, highThreshold: 2 })] });
  expect(() => assertCloseIntent(i, expectation())).toThrow(/thresholds would be raised/);
});

// Each threshold field is checked independently - a mutation collapsing any single one of the
// three OR'd comparisons must still be caught, not just masked by whichever field a test happens
// to set. Isolating low/med here (high is already isolated above, since low/med default to null).
test("rejects a set_options that raises only the low threshold", () => {
  const i = intent({ operations: [setOptions({ signer: null, lowThreshold: 2 })] });
  expect(() => assertCloseIntent(i, expectation())).toThrow(/thresholds would be raised/);
});

test("allows a set_options that sets the low threshold to exactly 1 (the close's own normalization)", () => {
  const i = intent({ operations: [setOptions({ signer: null, lowThreshold: 1 })] });
  expect(() => assertCloseIntent(i, expectation())).not.toThrow();
});

test("rejects a set_options that raises only the med threshold", () => {
  const i = intent({ operations: [setOptions({ signer: null, medThreshold: 2 })] });
  expect(() => assertCloseIntent(i, expectation())).toThrow(/thresholds would be raised/);
});

test("allows a set_options that sets the med threshold to exactly 1 (the close's own normalization)", () => {
  const i = intent({ operations: [setOptions({ signer: null, medThreshold: 1 })] });
  expect(() => assertCloseIntent(i, expectation())).not.toThrow();
});

test("allows a set_options that sets the high threshold to exactly 1 (the close's own normalization)", () => {
  const i = intent({ operations: [setOptions({ signer: null, highThreshold: 1 })] });
  expect(() => assertCloseIntent(i, expectation())).not.toThrow();
});

test("rejects a set_options that sets account flags", () => {
  const i = intent({ operations: [setOptions({ signer: null, setFlags: 1 })] });
  expect(() => assertCloseIntent(i, expectation())).toThrow(
    /change account flags, the home domain, or the inflation destination/
  );
});

test("rejects a set_options that clears account flags", () => {
  const i = intent({ operations: [setOptions({ signer: null, clearFlags: 1 })] });
  expect(() => assertCloseIntent(i, expectation())).toThrow(VerificationError);
});

test("rejects a set_options that changes the home domain", () => {
  const i = intent({ operations: [setOptions({ signer: null, homeDomain: "evil.example" })] });
  expect(() => assertCloseIntent(i, expectation())).toThrow(VerificationError);
});

test("rejects a set_options that changes the inflation destination", () => {
  const i = intent({ operations: [setOptions({ signer: null, inflationDest: ATTACKER })] });
  expect(() => assertCloseIntent(i, expectation())).toThrow(VerificationError);
});

test("a real SetOptions carrying a home-domain change is decoded and rejected (catches decode-shape bugs)", () => {
  const txXdr = buildXdr([
    Operation.setOptions({ homeDomain: "evil.example" }),
    Operation.accountMerge({ destination: DEST }),
  ]);
  const i = intentFromXdr(txXdr, Networks.TESTNET);
  expect(() => assertCloseIntent(i, expectation())).toThrow(VerificationError);
});

test("rejects a memo the user did not set", () => {
  const i = intent({ memo: "not-mine" });
  expect(() => assertCloseIntent(i, expectation({ memo: "mine" }))).toThrow(/memo you did not set/);
});

// A missing memo is not the same claim as a memo the user did not set - the transaction simply
// carries none, which the later "required memo" check (not this one) is responsible for.
test("does not reject a memo-less transaction just because the user typed one elsewhere", () => {
  const i = intent({ memo: null });
  expect(() =>
    assertCloseIntent(i, expectation({ memo: "typed-but-irrelevant-here" }))
  ).not.toThrow();
});

test("rejects a missing memo when the destination requires one (even if the user left it blank)", () => {
  const i = intent({ memo: null });
  expect(() =>
    assertCloseIntent(i, expectation({ memo: null, memoRequired: true, memoType: "id" }))
  ).toThrow(/requires a deposit memo/);
});

test("rejects a memo of the wrong type for the destination", () => {
  const i = intent({ memo: "12345", memoType: "text" });
  expect(() =>
    assertCloseIntent(i, expectation({ memo: "12345", memoRequired: true, memoType: "id" }))
  ).toThrow(/wrong type for this destination/);
});

// The required-memo check only applies to a transaction that actually delivers to the
// destination (a merge into it, or a payment restricted to only it). A step that does neither -
// an interim conversion, say - must not be held to a memo requirement that doesn't apply to it.
test("does not require a memo for an operation that does not deliver to the destination", () => {
  const i = intent({
    memo: null,
    guarantees: { mergeDestination: null, paymentsOnlyTo: [], minXlmFromConversions: "9" },
    operations: [conversion()],
  });
  expect(() =>
    assertCloseIntent(i, expectation({ memoRequired: true, memoType: "id" }))
  ).not.toThrow();
});

test("rejects a transaction for a different account", () => {
  const i = intent({ source: ATTACKER });
  expect(() => assertCloseIntent(i, expectation())).toThrow(/not for your account/);
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

// CAP-33's reserve-burden reversion makes this op family safe by construction (see the comment
// on the switch case) - there is nothing on the operation itself to check, but that "nothing to
// check" must still mean "passes", not "falls through to the fail-closed default and gets
// rejected as unrecognized".
test("allows a revoke_sponsorship operation", () => {
  const i = intent({
    operations: [{ source: SRC, type: "revoke_sponsorship", entryKind: "trustline", owner: SRC }],
  });
  expect(() => assertCloseIntent(i, expectation())).not.toThrow();
});

test("allows a claim_claimable_balance operation", () => {
  const i = intent({
    operations: [{ source: SRC, type: "claim_claimable_balance", balanceId: "deadbeef" }],
  });
  expect(() => assertCloseIntent(i, expectation())).not.toThrow();
});

// The exhaustiveness guard is unreachable through normalizeOp at runtime (anything it doesn't
// recognize becomes "unknown"), but assertCloseIntent is also called directly on hand-built
// intents (the pre-auth-tx manual path never goes through normalizeOp at all), so a producer
// bug or a genuinely novel op type must still fail closed here rather than silently pass.
test("fails closed on an operation type the switch does not recognize at all", () => {
  const bogus = { source: SRC, type: "totally_bogus_operation" } as unknown as IntentOperation;
  const i = intent({ operations: [bogus] });
  expect(() => assertCloseIntent(i, expectation())).toThrow(/unrecognized operation/i);
});

// ─── the mediated close is accepted on structure, not on identity (#116) ─────

const MEDIATED = () => expectation({ mediatorRequired: true, nativeBalance: BALANCE });

// The point of the change: no address is configured anywhere, and the close still verifies.
// The intermediary can be rotated without telling any client.
test("a mediated close passes without the client knowing the intermediary's address", () => {
  const anyIntermediary = Keypair.random().publicKey();
  expect(() => assertCloseIntent(intent(mediated(anyIntermediary)), MEDIATED())).not.toThrow();
});

// Structure alone is not enough, and this is why. "Whoever received the merge sends a payment
// onward" is satisfied by forwarding one stroop and keeping the rest - atomicity constrains
// whether the payment happens, never how much it carries. Without this floor an attacker who
// can alter the unsigned transaction nominates their own key as the intermediary and keeps the
// balance, which is exactly what pinning a known address used to prevent.
test("rejects an intermediary that forwards dust and keeps the balance", () => {
  const attackerKey = Keypair.random().publicKey();
  const i = intent(mediated(attackerKey, { amount: "0.0000001" }));
  expect(() => assertCloseIntent(i, MEDIATED())).toThrow(/only part of it/);
});

test("rejects a forward that is short by more than the fee tolerance", () => {
  const i = intent(mediated(Keypair.random().publicKey(), { amount: "99.5000000" }));
  expect(() => assertCloseIntent(i, MEDIATED())).toThrow(/only part of it/);
});

test("accepts a forward short only by the network fee", () => {
  const i = intent(mediated(Keypair.random().publicKey(), { amount: "99.9999000" }));
  expect(() => assertCloseIntent(i, MEDIATED())).not.toThrow();
});

// The tolerance is a floor: a forward landing exactly on it must pass, not just one comfortably
// inside it - pins the `<` boundary against an off-by-one toward `<=`.
test("accepts a forward exactly at the shortfall-tolerance floor", () => {
  const i = intent(mediated(Keypair.random().publicKey(), { amount: "99.9900000" }));
  expect(() => assertCloseIntent(i, MEDIATED())).not.toThrow();
});

// Isolates the "ops[1] must be a payment" half of the two-op shape check from the "ops[0] must
// be the merge" half: here ops[0] genuinely is the merge, so only ops[1] being a non-payment can
// be the reason this throws.
test("rejects a mediated close whose second operation is not a payment", () => {
  const intermediary = Keypair.random().publicKey();
  const i = intent({
    guarantees: {
      mergeDestination: intermediary,
      paymentsOnlyTo: [DEST],
      minXlmFromConversions: null,
    },
    operations: [merge(intermediary), setOptions()],
  });
  expect(() => assertCloseIntent(i, MEDIATED())).toThrow(/hand the balance straight on/);
});

// The hand-off shape only makes sense for a destination that cannot be merged into. Accepting
// it for a direct close would make an attacker-nominated intermediary reachable for every user.
test("rejects the mediated shape when the user did not route through an intermediary", () => {
  const i = intent(mediated(Keypair.random().publicKey()));
  expect(() => assertCloseIntent(i, expectation({ nativeBalance: BALANCE }))).toThrow(
    /did not choose/
  );
});

// The load-bearing relational assertion: merge into one account, forward from another, and the
// account holding the balance is under no obligation to pass it on.
test("rejects a forward sent by an account other than the one the merge paid into", () => {
  const i = intent(mediated(Keypair.random().publicKey(), { forwardSource: ATTACKER }));
  expect(() => assertCloseIntent(i, MEDIATED())).toThrow(/is the one passing them on/);
});

test("rejects a merge to an unexpected address with no forward at all", () => {
  const i = intent({
    guarantees: { mergeDestination: ATTACKER, paymentsOnlyTo: [], minXlmFromConversions: null },
    operations: [merge(ATTACKER)],
  });
  expect(() => assertCloseIntent(i, MEDIATED())).toThrow(/hand the balance straight on/);
});

test("rejects a mediated close carrying an extra operation", () => {
  const intermediary = Keypair.random().publicKey();
  const m = mediated(intermediary);
  const i = intent({ ...m, operations: [...m.operations, setOptions()] });
  expect(() => assertCloseIntent(i, MEDIATED())).toThrow(VerificationError);
});

test("rejects a forward to an address the user did not type", () => {
  const i = intent(mediated(Keypair.random().publicKey(), { forwardTo: ATTACKER }));
  expect(() => assertCloseIntent(i, MEDIATED())).toThrow(/unexpected address/);
});

test("rejects a forward that is not XLM", () => {
  const intermediary = Keypair.random().publicKey();
  const i = intent({
    guarantees: {
      mergeDestination: intermediary,
      paymentsOnlyTo: [DEST],
      minXlmFromConversions: null,
    },
    operations: [merge(intermediary), payment(DEST, `USDC:${ISSUER}`, intermediary, BALANCE)],
  });
  expect(() => assertCloseIntent(i, MEDIATED())).toThrow(/would not be XLM/);
});

test("rejects a merge not sent by the account being closed", () => {
  const intermediary = Keypair.random().publicKey();
  const i = intent({
    guarantees: {
      mergeDestination: intermediary,
      paymentsOnlyTo: [DEST],
      minXlmFromConversions: null,
    },
    operations: [merge(intermediary, ATTACKER), payment(DEST, "native", intermediary, BALANCE)],
  });
  expect(() => assertCloseIntent(i, MEDIATED())).toThrow(/not sent by the account being closed/);
});

test("rejects the two operations in the wrong order", () => {
  const intermediary = Keypair.random().publicKey();
  const i = intent({
    guarantees: {
      mergeDestination: intermediary,
      paymentsOnlyTo: [DEST],
      minXlmFromConversions: null,
    },
    operations: [payment(DEST, "native", intermediary, BALANCE), merge(intermediary)],
  });
  expect(() => assertCloseIntent(i, MEDIATED())).toThrow(VerificationError);
});

// A second merge riding along behind a well-formed first: `guarantees.mergeDestination` reports
// only the first, so reading that alone would wave this through.
test("rejects a transaction carrying a second account merge", () => {
  const i = intent({
    guarantees: { mergeDestination: DEST, paymentsOnlyTo: [], minXlmFromConversions: null },
    operations: [merge(DEST), merge(ATTACKER)],
  });
  expect(() => assertCloseIntent(i, expectation())).toThrow(/more than one account/);
});

// ─── verifyCloseTransaction: the exchange-derived memo policy (the wrapper, not assertCloseIntent) ──
//
// Every test above exercises assertCloseIntent directly, given an already-resolved
// memoRequired/memoType. Nothing above calls the actual entry point the guided flow uses before
// signing - verifyCloseTransaction - which is the only place that looks the destination up in
// the exchange registry and derives those two fields itself. A bug there (or the wrapper being
// dropped entirely) would be invisible to every test above.

// A real, curated exchange address (Coinbase) that requires a text memo, so the lookup exercises
// the actual registry rather than a stand-in.
const COINBASE = "GB5CLRWUCBQ6DFK2LR5ZMWJ7QCVEB3XKMPTQUYCDIYB4DRZJBEW6M26D";

function wrapperSigners(): AccountSigner[] {
  return [{ key: SRC, weight: 1, type: "ed25519_public_key" }];
}
const wrapperThresholds = { low: 0, med: 1, high: 1 };

test("verifyCloseTransaction passes a mediated close to a memo-requiring exchange when the memo is present", () => {
  const intermediary = Keypair.random().publicKey();
  const unsignedXdr = buildXdr(
    [
      Operation.accountMerge({ destination: intermediary }),
      Operation.payment({
        destination: COINBASE,
        asset: Asset.native(),
        amount: "100",
        source: intermediary,
      }),
    ],
    Memo.text("deposit-1")
  );
  expect(() =>
    verifyCloseTransaction({
      unsignedXdr,
      network: "testnet",
      expected: {
        source: SRC,
        destination: COINBASE,
        mediatorRequired: true,
        nativeBalance: "100.0000000",
        memo: "deposit-1",
        claimTrustlineAssets: [],
        transfers: {},
        exitContracts: [],
        heldTokenContracts: [],
        positionTokenContracts: [],
        accountSigners: wrapperSigners(),
        accountThresholds: wrapperThresholds,
      },
    })
  ).not.toThrow();
});

test("verifyCloseTransaction rejects a mediated close to a memo-requiring exchange when the memo is missing", () => {
  const intermediary = Keypair.random().publicKey();
  const unsignedXdr = buildXdr([
    Operation.accountMerge({ destination: intermediary }),
    Operation.payment({
      destination: COINBASE,
      asset: Asset.native(),
      amount: "100",
      source: intermediary,
    }),
  ]);
  expect(() =>
    verifyCloseTransaction({
      unsignedXdr,
      network: "testnet",
      expected: {
        source: SRC,
        destination: COINBASE,
        mediatorRequired: true,
        nativeBalance: "100.0000000",
        memo: null,
        claimTrustlineAssets: [],
        transfers: {},
        exitContracts: [],
        heldTokenContracts: [],
        positionTokenContracts: [],
        accountSigners: wrapperSigners(),
        accountThresholds: wrapperThresholds,
      },
    })
  ).toThrow(/requires a deposit memo/);
});

test("verifyCloseTransaction passes a direct close to a destination the registry does not recognize", () => {
  const unsignedXdr = buildXdr([Operation.accountMerge({ destination: DEST })]);
  expect(() =>
    verifyCloseTransaction({
      unsignedXdr,
      network: "testnet",
      expected: {
        source: SRC,
        destination: DEST,
        mediatorRequired: false,
        nativeBalance: "100.0000000",
        memo: null,
        claimTrustlineAssets: [],
        transfers: {},
        exitContracts: [],
        heldTokenContracts: [],
        positionTokenContracts: [],
        accountSigners: wrapperSigners(),
        accountThresholds: wrapperThresholds,
      },
    })
  ).not.toThrow();
});

// ─── Transfer payments (#112) ────────────────────────────────────────────────
//
// The riskiest widening in the epic. Return-to-issuer and the mediated forward are both
// structurally constrained - the issuer is derivable from the asset, the forward's destination
// is the address the user typed - so neither can be redirected. A transfer's destination is an
// arbitrary address, which is precisely the shape of a fund-diversion attack. The only thing
// separating a legitimate transfer from a diversion is that `expected.transfers` came from the
// user, so every one of these asks: can a transaction the user did NOT approve get through?

const TRANSFER_DEST = "GBTRANSFER000000000000000000000000000000000000000000000A";
const USDC = `USDC:${ISSUER}`;

const transferPayment = (
  destination = TRANSFER_DEST,
  amount = "10",
  asset = USDC
): IntentOperation => ({
  source: SRC,
  type: "payment",
  destination,
  asset,
  amount,
});

const chose = (over: Partial<{ destination: string; amount: string; asset: string }> = {}) => ({
  [over.asset ?? USDC]: {
    destination: over.destination ?? TRANSFER_DEST,
    amount: over.amount ?? "10",
  },
});

test("a transfer the user chose passes", () => {
  const i = intent({ operations: [transferPayment(), merge(DEST)] });
  expect(() => assertCloseIntent(i, expectation({ transfers: chose() }))).not.toThrow();
});

test("a transfer to an address the user never chose is rejected", () => {
  const i = intent({ operations: [transferPayment(ATTACKER), merge(DEST)] });
  expect(() => assertCloseIntent(i, expectation({ transfers: chose() }))).toThrow(
    /did not choose/i
  );
});

test("a destination valid for one asset does not authorize another", () => {
  // The user approved sending USDC to that account. A transaction that sends EURC there too
  // reuses a legitimate address for a balance the user never marked for transfer.
  const i = intent({
    operations: [transferPayment(TRANSFER_DEST, "10", `EURC:${ISSUER}`), merge(DEST)],
  });
  expect(() => assertCloseIntent(i, expectation({ transfers: chose() }))).toThrow(
    VerificationError
  );
});

test("a payment for an asset with no transfer chosen is rejected", () => {
  const i = intent({ operations: [transferPayment(), merge(DEST)] });
  expect(() => assertCloseIntent(i, expectation({ transfers: {} }))).toThrow(/unexpected address/i);
});

test("an altered amount is rejected", () => {
  // Binding only the destination would let this through: right account, wrong amount.
  const i = intent({ operations: [transferPayment(TRANSFER_DEST, "0.0000001"), merge(DEST)] });
  expect(() => assertCloseIntent(i, expectation({ transfers: chose() }))).toThrow(/less USDC/i);
});

test("more than approved is allowed: a claim round legitimately raises the balance", () => {
  // The API claims a claimable balance of the same asset BEFORE disposing of the trustline,
  // so the built amount exceeds the figure shown at analyze time. Rejecting that failed the
  // close after the claim was already signed and submitted. Safe because the destination is
  // pinned: the extra goes exactly where the user said.
  const i = intent({ operations: [transferPayment(TRANSFER_DEST, "1000"), merge(DEST)] });
  expect(() => assertCloseIntent(i, expectation({ transfers: chose() }))).not.toThrow();
});

test("the amount is compared in whole stroops, not as decimal strings", () => {
  // Same value, different spelling. A string comparison would reject this legitimate transfer.
  const i = intent({ operations: [transferPayment(TRANSFER_DEST, "10.0000000"), merge(DEST)] });
  expect(() =>
    assertCloseIntent(i, expectation({ transfers: chose({ amount: "10" }) }))
  ).not.toThrow();
});

test("the same approved transfer repeated is rejected", () => {
  // Each copy matches the user's choice individually; together they pay it twice.
  const i = intent({ operations: [transferPayment(), transferPayment(), merge(DEST)] });
  expect(() => assertCloseIntent(i, expectation({ transfers: chose() }))).toThrow(
    /more than once/i
  );
});

test("the rejection names the asset code, so the user can tell which one is wrong", () => {
  // The messages are what a user acts on. Without asserting them, every mutation of the label
  // survives - the regexes above only match the fixed part of the sentence.
  const i = intent({ operations: [transferPayment(ATTACKER), merge(DEST)] });
  expect(() => assertCloseIntent(i, expectation({ transfers: chose() }))).toThrow(/send USDC to/);

  const wrongAmount = intent({ operations: [transferPayment(TRANSFER_DEST, "1"), merge(DEST)] });
  expect(() => assertCloseIntent(wrongAmount, expectation({ transfers: chose() }))).toThrow(
    /less USDC/
  );

  const twice = intent({ operations: [transferPayment(), transferPayment(), merge(DEST)] });
  expect(() => assertCloseIntent(twice, expectation({ transfers: chose() }))).toThrow(
    /send USDC more than once/
  );

  // The issuer is not part of the label: "USDC:GABC..." would be noise in a user-facing message.
  try {
    assertCloseIntent(i, expectation({ transfers: chose() }));
  } catch (e) {
    expect((e as Error).message).not.toContain(ISSUER);
  }
});

test("a transfer does not loosen the issuer-return rule", () => {
  // Paying an asset to its own issuer stays allowed on its own terms, with no transfer chosen.
  const i = intent({
    operations: [transferPayment(ISSUER, "10", USDC), merge(DEST)],
  });
  expect(() => assertCloseIntent(i, expectation({ transfers: {} }))).not.toThrow();
});

test("a close with no transfers verifies exactly as before", () => {
  // The allowlist widened only where intended: a convert-only close is unaffected.
  const i = intent({ operations: [conversion(), merge(DEST)] });
  expect(() => assertCloseIntent(i, expectation({ transfers: {} }))).not.toThrow();
});

test("a transfer debiting a different account is rejected", () => {
  // The finding a security review caught: pinning asset, destination and amount says nothing
  // about WHICH account pays. One Stellar signature satisfies every operation whose source
  // lists that key with enough weight, so a key that signs for two accounts would otherwise
  // authorize closing one and debiting the other in the same transaction.
  const i = intent({
    operations: [{ ...transferPayment(), source: ATTACKER }, merge(DEST)],
  });
  expect(() => assertCloseIntent(i, expectation({ transfers: chose() }))).toThrow(
    /from an account other than the one being closed/
  );
});

test("an issuer-return debiting a different account is rejected too", () => {
  // The same gap existed on the pre-existing branch; the check sits on the whole payment arm.
  const i = intent({
    operations: [{ ...transferPayment(ISSUER, "10", USDC), source: ATTACKER }, merge(DEST)],
  });
  expect(() => assertCloseIntent(i, expectation({ transfers: {} }))).toThrow(
    /from an account other than the one being closed/
  );
});

test("the mediated forward is exempt: it is sent by the intermediary, not the source", () => {
  // assertMergeShape has already pinned the forward's source to the account the merge paid
  // into, so applying the source rule to it would break every exchange close.
  const INTERMEDIARY = "GBMEDIATOR00000000000000000000000000000000000000000000AA";
  const i = intent({
    operations: [
      merge(INTERMEDIARY),
      { source: INTERMEDIARY, type: "payment", destination: DEST, asset: "native", amount: "100" },
    ],
    memo: "deposit-1",
    memoType: "text",
  });
  expect(() =>
    assertCloseIntent(
      i,
      expectation({
        destination: DEST,
        mediatorRequired: true,
        memo: "deposit-1",
        memoRequired: true,
        memoType: "text",
        transfers: {},
      })
    )
  ).not.toThrow();
});

// ─── DeFi exits: a contract invocation is checked structurally ───────────────

const POOL = "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF";
const XLM_SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const OTHER_POOL = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
type ExitOp = Extract<IntentOperation, { type: "invoke_host_function" }>;
const exit = (over: Partial<ExitOp> = {}): IntentOperation => ({
  source: SRC,
  type: "invoke_host_function",
  contract: POOL,
  function: "submit",
  args: [],
  accountsReferenced: [SRC],
  contractsReferenced: [POOL],
  unsupportedAddressCount: 0,
  authorizesBeyondSelf: false,
  ...over,
});
const exitOnly = (op: IntentOperation, fee = "100") =>
  intent({
    fee,
    operations: [op],
    guarantees: { mergeDestination: null, paymentsOnlyTo: [], minXlmFromConversions: null },
  });

test("an exit that acts for, and only names, the account being closed, against a contract it holds a position in, passes", () => {
  expect(() => assertCloseIntent(exitOnly(exit()), expectation())).not.toThrow();
});

test("an exit may name the token contracts of assets the account holds - a repay spends one", () => {
  const op = exit({ contractsReferenced: [POOL, XLM_SAC] });
  expect(() => assertCloseIntent(exitOnly(op), expectation())).not.toThrow();
});

test("rejects an exit whose arguments name any other account - proceeds could go there", () => {
  const op = exit({ accountsReferenced: [SRC, ATTACKER] });
  expect(() => assertCloseIntent(exitOnly(op), expectation())).toThrow(
    /other than the one being closed/
  );
});

test("rejects an exit that names a contract the account has no position or balance in - a contract-typed recipient", () => {
  const op = exit({ contractsReferenced: [POOL, OTHER_POOL] });
  expect(() => assertCloseIntent(exitOnly(op), expectation())).toThrow(/no position, balance, or pool token in/);
});

test("rejects an exit that invokes a contract the analysis never showed a position in", () => {
  const op = exit({ contract: OTHER_POOL, contractsReferenced: [OTHER_POOL] });
  expect(() => assertCloseIntent(exitOnly(op), expectation())).toThrow(/not one of this account/);
});

test("rejects an exit when the client has no positions to pin it to - fails closed", () => {
  expect(() => assertCloseIntent(exitOnly(exit()), expectation({ exitContracts: [] }))).toThrow(
    VerificationError
  );
});

test("rejects an exit that names an address form the check cannot pin - a muxed recipient", () => {
  const op = exit({ unsupportedAddressCount: 1 });
  expect(() => assertCloseIntent(exitOnly(op), expectation())).toThrow(/cannot be verified/);
});

test("rejects an exit whose signature would authorize more than the account's own call - a hidden sub-invocation or another party's credentials", () => {
  const op = exit({ authorizesBeyondSelf: true });
  expect(() => assertCloseIntent(exitOnly(op), expectation())).toThrow(/beyond this account/);
});

test("rejects an exit sourced from another account", () => {
  const op = exit({ source: ATTACKER });
  expect(() => assertCloseIntent(exitOnly(op), expectation())).toThrow(/act for an account other/);
});

test("rejects an exit whose fee is far above what any exit costs", () => {
  expect(() => assertCloseIntent(exitOnly(exit(), "10000001"), expectation())).toThrow(
    /network fee far above/
  );
  expect(() => assertCloseIntent(exitOnly(exit(), "10000000"), expectation())).not.toThrow();
});

test("rejects an exit that shares its transaction with anything else", () => {
  const i = intent({ operations: [exit(), merge(DEST)] });
  expect(() => assertCloseIntent(i, expectation())).toThrow(/only operation/);
});

test("an AMM withdrawal may invoke the protocol's router and name the pair's tokens", () => {
  const ROUTER = "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD";
  const TOKEN = "CBRQHWJDLPYVR4BSVUUWJCZGG4N4FF3CUZKDGRVTE36FAWNEJZEMQRME";
  const op = exit({
    contract: ROUTER,
    function: "remove_liquidity",
    contractsReferenced: [POOL, ROUTER, TOKEN, XLM_SAC],
  });
  const expected = expectation({
    exitContracts: [POOL, ROUTER],
    positionTokenContracts: [TOKEN, XLM_SAC],
  });
  expect(() => assertCloseIntent(exitOnly(op), expected)).not.toThrow();
  // The same call without the router in the pinned set - an expired or unknown registry - fails.
  expect(() =>
    assertCloseIntent(exitOnly(op), expectation({ positionTokenContracts: [TOKEN, XLM_SAC] }))
  ).toThrow(/not one of this account/);
  // And a pool token the position does not have is not a place funds may go.
  expect(() =>
    assertCloseIntent(exitOnly(op), expectation({ exitContracts: [POOL, ROUTER] }))
  ).toThrow(/no position, balance, or pool token/);
});
