import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import {
  Account,
  Address,
  Asset,
  hash,
  Keypair,
  Memo,
  nativeToScVal,
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
import { fromHex, toHex } from "@/lib/stellar/hex";
import { activeRegistry, setRegistry } from "@/lib/exchange-registry";
import { exitExpectations } from "@/lib/stellar/exit-expectations";
import type { AccountState } from "@/types/account";
import { REAL_EXIT_ENVELOPES, type RealExitEnvelope } from "./fixtures/real-exit-envelopes";

const SRC = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const MED = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const ATTACKER = Keypair.random().publicKey();
const REMOVED_SIGNER = Keypair.random().publicKey();
const NOW = 1_800_000_000;

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
    tokenTransfers: {},
    classicConversions: { [`USDC:${ISSUER}`]: { minAmountOut: "90000000" } },
    tokenConversions: {},
    conversionContracts: [SOROSWAP_ROUTER],
    xlmContract: XLM_SAC,
    exitContracts: [POOL],
    heldTokenContracts: [XLM_SAC],
    positionTokenContracts: [],
    exitFunctions: { [POOL]: ["submit"] },
    accountSigners: [
      { key: SRC, weight: 1, type: "ed25519_public_key" },
      { key: REMOVED_SIGNER, weight: 1, type: "ed25519_public_key" },
    ],
    accountThresholds: { low: 0, med: 1, high: 1 },
    nowSeconds: NOW,
    // Exit contracts count as registry-listed unless a test says otherwise.
    registryContracts: over.exitContracts ?? [POOL],
    protectedTokenContracts: [],
    xbullAssets: { "0": XLM_CONTRACT, "1": CONVERT_TOKEN, "2": OTHER_TOKEN },
    ownTokensByContract: {},
    ...over,
  };
}

function intent(over: Partial<TxIntent> = {}): TxIntent {
  return {
    summary: "",
    source: SRC,
    fee: "100",
    maxTime: String(NOW + 300),
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
  expect(() =>
    assertCloseIntent(
      i,
      expectation({ transfers: { [`USDC:${ISSUER}`]: { destination: ISSUER, amount: "5" } } })
    )
  ).not.toThrow();
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
  return builder.build().toEnvelope().toXdr("base64");
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
    payload: fromHex("cafebabe"),
  }).toXdr();
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
  const preimage = fromHex("deadbeef");
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
  const built = TransactionBuilder.fromXdr(unsignedXdr, Networks.TESTNET);
  built.signHashX(preimage);
  const signedXdr = built.toEnvelope().toXdr("base64");

  const signedIntent = intentFromXdr(signedXdr, Networks.TESTNET);
  expect(signedIntent).toEqual(unsignedIntent);
  expect(() => assertCloseIntent(signedIntent, expectation({ accountSigners }))).not.toThrow();
});

test.each([0, 1, 2])("rejects a set_options that sets the master key to weight %i", (weight) => {
  const i = intent({ operations: [setOptions({ signer: null, masterWeight: weight })] });
  expect(() => assertCloseIntent(i, expectation())).toThrow(/master key's weight would be changed/);
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
  const i = intent({ memo: "not-mine", operations: [merge(DEST)] });
  expect(() => assertCloseIntent(i, expectation({ memo: "mine" }))).toThrow(/memo you did not set/);
});

// A missing memo is not the same claim as a memo the user did not set - the transaction simply
// carries none, which the later "required memo" check (not this one) is responsible for.
test("does not reject a memo-less transaction just because the user typed one elsewhere", () => {
  const i = intent({ memo: null, operations: [merge(DEST)] });
  expect(() =>
    assertCloseIntent(i, expectation({ memo: "typed-but-irrelevant-here" }))
  ).not.toThrow();
});

test("rejects a missing memo when the destination requires one (even if the user left it blank)", () => {
  const i = intent({ memo: null, operations: [merge(DEST)] });
  expect(() =>
    assertCloseIntent(i, expectation({ memo: null, memoRequired: true, memoType: "id" }))
  ).toThrow(/requires a deposit memo/);
});

test("rejects a memo of the wrong type for the destination", () => {
  const i = intent({ memo: "12345", memoType: "text", operations: [merge(DEST)] });
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
        tokenTransfers: {},
        classicConversions: {},
        tokenConversions: {},
        conversionContracts: [],
        xlmContract: XLM_SAC,
        exitContracts: [],
        heldTokenContracts: [],
        positionTokenContracts: [],
        exitFunctions: {},
        accountSigners: wrapperSigners(),
        accountThresholds: wrapperThresholds,
        registryContracts: [],
        protectedTokenContracts: [],
        xbullAssets: {},
        ownTokensByContract: {},
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
        tokenTransfers: {},
        classicConversions: {},
        tokenConversions: {},
        conversionContracts: [],
        xlmContract: XLM_SAC,
        exitContracts: [],
        heldTokenContracts: [],
        positionTokenContracts: [],
        exitFunctions: {},
        accountSigners: wrapperSigners(),
        accountThresholds: wrapperThresholds,
        registryContracts: [],
        protectedTokenContracts: [],
        xbullAssets: {},
        ownTokensByContract: {},
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
        tokenTransfers: {},
        classicConversions: {},
        tokenConversions: {},
        conversionContracts: [],
        xlmContract: XLM_SAC,
        exitContracts: [],
        heldTokenContracts: [],
        positionTokenContracts: [],
        exitFunctions: {},
        accountSigners: wrapperSigners(),
        accountThresholds: wrapperThresholds,
        registryContracts: [],
        protectedTokenContracts: [],
        xbullAssets: {},
        ownTokensByContract: {},
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

test("a return to the issuer passes only for an asset the user chose to return", () => {
  const i = intent({
    operations: [transferPayment(ISSUER, "10", USDC), merge(DEST)],
  });
  const returned = { [USDC]: { destination: ISSUER, amount: "10" } };
  expect(() => assertCloseIntent(i, expectation({ transfers: returned }))).not.toThrow();
  expect(() => assertCloseIntent(i, expectation({ transfers: {} }))).toThrow(VerificationError);
  expect(() =>
    assertCloseIntent(
      i,
      expectation({ transfers: { [USDC]: { destination: ISSUER, amount: "11" } } })
    )
  ).toThrow(/less USDC than you approved/);
  expect(() =>
    assertCloseIntent(
      i,
      expectation({ transfers: { [USDC]: { destination: TRANSFER_DEST, amount: "10" } } })
    )
  ).toThrow(/address you did not choose/);
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
        tokenTransfers: {},
        classicConversions: {},
        tokenConversions: {},
        conversionContracts: [],
      })
    )
  ).not.toThrow();
});

// ─── DeFi exits: a contract invocation is checked structurally ───────────────

const POOL = "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF";
const XLM_SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const OTHER_POOL = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
// The registry's mainnet Soroswap router: the one contract a conversion may be entered through.
const SOROSWAP_ROUTER = "CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH";
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
  authDepth: 0,
  subInvocations: [],
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
  expect(() => assertCloseIntent(exitOnly(op), expectation())).toThrow(
    /no position, balance, or pool token in/
  );
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
  const functions = { [POOL]: [], [ROUTER]: ["remove_liquidity"] };
  const expected = expectation({
    exitContracts: [POOL, ROUTER],
    positionTokenContracts: [TOKEN, XLM_SAC],
    exitFunctions: functions,
  });
  expect(() => assertCloseIntent(exitOnly(op), expected)).not.toThrow();
  // The same call without the router in the pinned set - an expired or unknown registry - fails.
  expect(() =>
    assertCloseIntent(
      exitOnly(op),
      expectation({ positionTokenContracts: [TOKEN, XLM_SAC], exitFunctions: functions })
    )
  ).toThrow(/not one of this account/);
  // A pool token the position does not have is not a place funds may go.
  expect(() =>
    assertCloseIntent(
      exitOnly(op),
      expectation({ exitContracts: [POOL, ROUTER], exitFunctions: functions })
    )
  ).toThrow(/no position, balance, or pool token/);
  // The router may only be asked to remove liquidity - never to swap, whatever the API says.
  expect(() =>
    assertCloseIntent(
      exitOnly(
        exit({
          contract: ROUTER,
          function: "swap_exact_tokens_for_tokens",
          contractsReferenced: [POOL, ROUTER, TOKEN, XLM_SAC],
        })
      ),
      expected
    )
  ).toThrow(/function LumenWipe does not use/);
  // And the pair itself is never a call target, even though it is a detected position.
  expect(() =>
    assertCloseIntent(
      exitOnly(
        exit({ contract: POOL, function: "withdraw", contractsReferenced: [POOL, TOKEN, XLM_SAC] })
      ),
      expected
    )
  ).toThrow(/function LumenWipe does not use/);
});

test("a Blend exit may only call submit on its pool", () => {
  expect(() =>
    assertCloseIntent(exitOnly(exit({ function: "flash_loan" })), expectation())
  ).toThrow(/function LumenWipe does not use/);
});

test("a Blend exit may claim emissions on its pool and withdraw a queued deposit from the registry's backstop, nothing else", () => {
  const BACKSTOP = "CBDVWXT433PRVTUNM56C3JREF3HIZHRBA64NB2C3B2UNCKIS65ZYCLZA";
  const expected = expectation({
    exitContracts: [POOL, BACKSTOP],
    exitFunctions: { [POOL]: ["submit", "claim"], [BACKSTOP]: ["withdraw"] },
  });
  const claim = exit({ function: "claim", contractsReferenced: [POOL] });
  expect(() => assertCloseIntent(exitOnly(claim), expected)).not.toThrow();
  // The backstop call names the pool it backs among its arguments.
  const withdraw = exit({
    contract: BACKSTOP,
    function: "withdraw",
    contractsReferenced: [BACKSTOP, POOL],
  });
  expect(() => assertCloseIntent(exitOnly(withdraw), expected)).not.toThrow();
  // The pool's functions do not carry over to the backstop, nor the other way round.
  expect(() =>
    assertCloseIntent(exitOnly(exit({ contract: BACKSTOP, function: "submit" })), expected)
  ).toThrow(/function LumenWipe does not use/);
  expect(() => assertCloseIntent(exitOnly(exit({ function: "withdraw" })), expected)).toThrow(
    /function LumenWipe does not use/
  );
  expect(() =>
    assertCloseIntent(
      exitOnly(exit({ contract: BACKSTOP, function: "queue_withdrawal" })),
      expected
    )
  ).toThrow(/function LumenWipe does not use/);
});

test("a Phoenix exit may withdraw_liquidity on its pool and unbond on the registry's stake contract, nothing else", () => {
  const STAKE = "CCELNFRXYUDJ5545AM7KIMHDHII5PQEGDVYHA3HSR7HXWUNH67EWBFXP";
  const expected = expectation({
    exitContracts: [POOL, STAKE],
    exitFunctions: { [POOL]: ["withdraw_liquidity"], [STAKE]: ["unbond"] },
  });
  const withdraw = exit({ function: "withdraw_liquidity", contractsReferenced: [POOL] });
  expect(() => assertCloseIntent(exitOnly(withdraw), expected)).not.toThrow();
  // The stake call names the pool's own contract only through op.contract, not contractsReferenced.
  const unbond = exit({ contract: STAKE, function: "unbond", contractsReferenced: [STAKE] });
  expect(() => assertCloseIntent(exitOnly(unbond), expected)).not.toThrow();
  // The pool's function does not carry over to the stake contract, nor the other way round.
  expect(() =>
    assertCloseIntent(exitOnly(exit({ contract: STAKE, function: "withdraw_liquidity" })), expected)
  ).toThrow(/function LumenWipe does not use/);
  expect(() => assertCloseIntent(exitOnly(exit({ function: "unbond" })), expected)).toThrow(
    /function LumenWipe does not use/
  );
});

test("a FxDAO exit may only call pay_debt on its vault", () => {
  expect(() =>
    assertCloseIntent(exitOnly(exit({ function: "withdraw_collateral" })), expectation())
  ).toThrow(/function LumenWipe does not use/);
  const expected = expectation({ exitFunctions: { [POOL]: ["pay_debt"] } });
  expect(() => assertCloseIntent(exitOnly(exit({ function: "pay_debt" })), expected)).not.toThrow();
});

test("an Aquarius exit may call withdraw or claim on its pool, and the share token it burns is a permitted contract", () => {
  const SHARE_TOKEN = "CAN7DMIQH7FGKNYCUQMWECJJ74EKN5JATVVUOVTXOWLQGZCWAFWANG5P";
  const expected = expectation({
    exitFunctions: { [POOL]: ["withdraw", "claim"] },
    positionTokenContracts: [SHARE_TOKEN],
  });
  const withdraw = exit({
    function: "withdraw",
    contractsReferenced: [POOL, SHARE_TOKEN, XLM_SAC],
  });
  expect(() => assertCloseIntent(exitOnly(withdraw), expected)).not.toThrow();
  const claim = exit({ function: "claim", contractsReferenced: [POOL] });
  expect(() => assertCloseIntent(exitOnly(claim), expected)).not.toThrow();
  expect(() => assertCloseIntent(exitOnly(exit({ function: "deposit" })), expected)).toThrow(
    /function LumenWipe does not use/
  );
});

// ─── DeFi exit sub-invocations: a legitimate top-level call may hide a diversion (#208) ──────

test("an exit's sub-invocation may transfer a held token to this account or to the exit contract itself", () => {
  const expected = expectation({ heldTokenContracts: [XLM_SAC] });
  const toSelf = exit({
    contractsReferenced: [POOL, XLM_SAC],
    subInvocations: [{ contract: XLM_SAC, function: "transfer", args: [SRC, SRC, "100"] }],
  });
  expect(() => assertCloseIntent(exitOnly(toSelf), expected)).not.toThrow();
  // The pool paying itself (e.g. a repay leg the top-level `submit` call triggers) is the whole
  // point of an exit - the recipient is the very contract this invocation is rooted at.
  const toPool = exit({
    contractsReferenced: [POOL, XLM_SAC],
    subInvocations: [{ contract: XLM_SAC, function: "transfer", args: [SRC, POOL, "100"] }],
  });
  expect(() => assertCloseIntent(exitOnly(toPool), expected)).not.toThrow();
});

test("rejects a Blend exit whose submit call hides a transfer of the held asset to a third party", () => {
  // The top-level call is exactly what a legitimate Blend repay-and-withdraw looks like -
  // `submit` on the pool, nothing else referenced at the top level. Only the authorization
  // tree the same signature satisfies carries the diversion.
  const op = exit({
    contractsReferenced: [POOL, XLM_SAC],
    subInvocations: [{ contract: XLM_SAC, function: "transfer", args: [SRC, ATTACKER, "100"] }],
  });
  expect(() =>
    assertCloseIntent(exitOnly(op), expectation({ heldTokenContracts: [XLM_SAC] }))
  ).toThrow(/other than this account or the protocol/);
});

test("rejects an Aquarius exit whose withdraw call hides a transfer of the share token to a third party", () => {
  const SHARE_TOKEN = "CAN7DMIQH7FGKNYCUQMWECJJ74EKN5JATVVUOVTXOWLQGZCWAFWANG5P";
  const op = exit({
    function: "withdraw",
    contractsReferenced: [POOL, SHARE_TOKEN],
    subInvocations: [{ contract: SHARE_TOKEN, function: "transfer", args: [SRC, ATTACKER, "5"] }],
  });
  const expected = expectation({
    exitFunctions: { [POOL]: ["withdraw", "claim"] },
    positionTokenContracts: [SHARE_TOKEN],
  });
  expect(() => assertCloseIntent(exitOnly(op), expected)).toThrow(
    /other than this account or the protocol/
  );
});

test("rejects a Soroswap router exit whose remove_liquidity call hides a transfer of a pair token to a third party", () => {
  const ROUTER = "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD";
  const TOKEN = "CBRQHWJDLPYVR4BSVUUWJCZGG4N4FF3CUZKDGRVTE36FAWNEJZEMQRME";
  const op = exit({
    contract: ROUTER,
    function: "remove_liquidity",
    contractsReferenced: [POOL, ROUTER, TOKEN, XLM_SAC],
    subInvocations: [{ contract: TOKEN, function: "transfer", args: [SRC, ATTACKER, "100"] }],
  });
  const expected = expectation({
    exitContracts: [POOL, ROUTER],
    positionTokenContracts: [TOKEN, XLM_SAC],
    exitFunctions: { [POOL]: [], [ROUTER]: ["remove_liquidity"] },
  });
  expect(() => assertCloseIntent(exitOnly(op), expected)).toThrow(
    /other than this account or the protocol/
  );
});

test("rejects a Phoenix unbond whose call hides a transfer of the share token to a third party", () => {
  const STAKE = "CCELNFRXYUDJ5545AM7KIMHDHII5PQEGDVYHA3HSR7HXWUNH67EWBFXP";
  const SHARE_TOKEN = "CAN7DMIQH7FGKNYCUQMWECJJ74EKN5JATVVUOVTXOWLQGZCWAFWANG5P";
  const op = exit({
    contract: STAKE,
    function: "unbond",
    contractsReferenced: [STAKE, SHARE_TOKEN],
    subInvocations: [{ contract: SHARE_TOKEN, function: "transfer", args: [STAKE, ATTACKER, "5"] }],
  });
  const expected = expectation({
    exitContracts: [POOL, STAKE],
    positionTokenContracts: [SHARE_TOKEN],
    exitFunctions: { [POOL]: ["withdraw_liquidity"], [STAKE]: ["unbond"] },
  });
  expect(() => assertCloseIntent(exitOnly(op), expected)).toThrow(
    /other than this account or the protocol/
  );
});

test("rejects a FxDAO pay_debt whose call hides a transfer of the debt asset to a third party", () => {
  const op = exit({
    function: "pay_debt",
    contractsReferenced: [POOL, XLM_SAC],
    subInvocations: [{ contract: XLM_SAC, function: "transfer", args: [SRC, ATTACKER, "100"] }],
  });
  const expected = expectation({
    exitFunctions: { [POOL]: ["pay_debt"] },
    heldTokenContracts: [XLM_SAC],
  });
  expect(() => assertCloseIntent(exitOnly(op), expected)).toThrow(
    /other than this account or the protocol/
  );
});

test("rejects an exit sub-invocation that spends a token's allowance to a third-party spender", () => {
  // approve(from, spender, amount, expiration_ledger) - the spender must be pinned exactly like
  // a transfer's recipient, or a hostile build could grant an attacker contract standing
  // approval over the account's held balance instead of moving it directly.
  const op = exit({
    contractsReferenced: [POOL, XLM_SAC],
    subInvocations: [
      { contract: XLM_SAC, function: "approve", args: [SRC, ATTACKER, "100", "999999"] },
    ],
  });
  expect(() =>
    assertCloseIntent(exitOnly(op), expectation({ heldTokenContracts: [XLM_SAC] }))
  ).toThrow(/other than this account or the protocol/);
});

test("rejects an exit sub-invocation calling a function on a token that no exit legitimately needs", () => {
  // Not transfer/transfer_from/approve/burn/burn_from - e.g. an admin-only function some tokens
  // expose. The recipient-pinning rule above cannot even apply; the call itself is refused.
  const op = exit({
    contractsReferenced: [POOL, XLM_SAC],
    subInvocations: [{ contract: XLM_SAC, function: "set_admin", args: [ATTACKER] }],
  });
  expect(() =>
    assertCloseIntent(exitOnly(op), expectation({ heldTokenContracts: [XLM_SAC] }))
  ).toThrow(/LumenWipe does not use to leave a protocol/);
});

test("a burn sub-invocation on a held token needs no recipient pinning - it destroys value, moving it nowhere", () => {
  const op = exit({
    contractsReferenced: [POOL, XLM_SAC],
    subInvocations: [{ contract: XLM_SAC, function: "burn", args: [SRC, "100"] }],
  });
  expect(() =>
    assertCloseIntent(exitOnly(op), expectation({ heldTokenContracts: [XLM_SAC] }))
  ).not.toThrow();
});

test("rejects a transfer-shaped sub-invocation whose argument count does not match transfer's real signature", () => {
  // Recognized function name, wrong arity - could not be a real transfer() call, so the
  // recipient argument this rule would otherwise trust cannot be assumed to sit at index 1.
  const op = exit({
    contractsReferenced: [POOL, XLM_SAC],
    subInvocations: [{ contract: XLM_SAC, function: "transfer", args: [SRC, "100"] }],
  });
  expect(() =>
    assertCloseIntent(exitOnly(op), expectation({ heldTokenContracts: [XLM_SAC] }))
  ).toThrow(/argument count/);
});

test("a sub-invocation on a contract that is not a held or position token is unaffected by this rule", () => {
  // A pool calling another already-pinned exit contract (e.g. an oracle or a router leg) is
  // covered by the existing contractsReferenced allow-list, not this token-specific rule.
  const OTHER_EXIT_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
  const op = exit({
    contractsReferenced: [POOL, OTHER_EXIT_CONTRACT],
    subInvocations: [{ contract: OTHER_EXIT_CONTRACT, function: "anything_at_all", args: [] }],
  });
  expect(() =>
    assertCloseIntent(exitOnly(op), expectation({ exitContracts: [POOL, OTHER_EXIT_CONTRACT] }))
  ).not.toThrow();
});

// ─── Soroban token transfers (#161) ──────────────────────────────────────────

const TOKEN = "CBI7UCH5KGSVQRO5H4SUCZUTZABCITZLRHQQZTWL2TK4RZ72TAR6IHRV";
const tokenTransfer = (over: Partial<ExitOp> = {}): IntentOperation => ({
  source: SRC,
  type: "invoke_host_function",
  contract: TOKEN,
  function: "transfer",
  args: [SRC, DEST, "2500000000"],
  accountsReferenced: [SRC, DEST],
  contractsReferenced: [TOKEN],
  unsupportedAddressCount: 0,
  authorizesBeyondSelf: false,
  authDepth: 0,
  subInvocations: [],
  ...over,
});
const chosenToken = (amount = "2500000000") =>
  expectation({ tokenTransfers: { [TOKEN]: { destination: DEST, amount } } });

test("a token transfer of at least the balance shown, to the account the user chose, under the account's own plain call, passes", () => {
  expect(() => assertCloseIntent(exitOnly(tokenTransfer()), chosenToken())).not.toThrow();
  // The live balance grew since the read: more to an already-pinned destination is not a loss.
  expect(() =>
    assertCloseIntent(exitOnly(tokenTransfer({ args: [SRC, DEST, "2500000001"] })), chosenToken())
  ).not.toThrow();
});

test("rejects a token transfer to an address the user did not choose - the diversion this rule exists for", () => {
  expect(() =>
    assertCloseIntent(
      exitOnly(
        tokenTransfer({ args: [SRC, ATTACKER, "2500000000"], accountsReferenced: [SRC, ATTACKER] })
      ),
      chosenToken()
    )
  ).toThrow(/address you did not choose/);
});

test("rejects a token transfer of less than the balance the user was shown, or of an unreadable amount", () => {
  expect(() =>
    assertCloseIntent(exitOnly(tokenTransfer({ args: [SRC, DEST, "2499999999"] })), chosenToken())
  ).toThrow(/less than the balance/);
  expect(() =>
    assertCloseIntent(exitOnly(tokenTransfer({ args: [SRC, DEST, '"2500000000"'] })), chosenToken())
  ).toThrow(/less than the balance/);
});

test("rejects a token transfer that moves another account's balance", () => {
  expect(() =>
    assertCloseIntent(
      exitOnly(
        tokenTransfer({
          args: [ATTACKER, DEST, "2500000000"],
          accountsReferenced: [ATTACKER, DEST],
        })
      ),
      chosenToken()
    )
  ).toThrow(/other than this account's own/);
});

test("rejects a token call that is not a plain three-argument transfer", () => {
  expect(() =>
    assertCloseIntent(exitOnly(tokenTransfer({ function: "approve" })), chosenToken())
  ).toThrow(/something other than a plain transfer/);
  expect(() =>
    assertCloseIntent(exitOnly(tokenTransfer({ args: [SRC, DEST] })), chosenToken())
  ).toThrow(/something other than a plain transfer/);
});

test("rejects a token whose transfer makes the account authorize anything else - a nested call or foreign credentials", () => {
  expect(() => assertCloseIntent(exitOnly(tokenTransfer({ authDepth: 1 })), chosenToken())).toThrow(
    /beyond the transfer itself/
  );
  expect(() =>
    assertCloseIntent(exitOnly(tokenTransfer({ authorizesBeyondSelf: true })), chosenToken())
  ).toThrow(/beyond the transfer itself/);
});

test("rejects a token transfer that names any other account or contract, or an address form it cannot pin", () => {
  expect(() =>
    assertCloseIntent(
      exitOnly(tokenTransfer({ accountsReferenced: [SRC, DEST, ATTACKER] })),
      chosenToken()
    )
  ).toThrow(/other than this one and your chosen destination/);
  expect(() =>
    assertCloseIntent(
      exitOnly(tokenTransfer({ contractsReferenced: [TOKEN, OTHER_POOL] })),
      chosenToken()
    )
  ).toThrow(/other than the token itself/);
  expect(() =>
    assertCloseIntent(exitOnly(tokenTransfer({ unsupportedAddressCount: 1 })), chosenToken())
  ).toThrow(/cannot be verified/);
});

test("rejects a token transfer that is not alone, acts for another account, or pays an outsized fee", () => {
  expect(() =>
    assertCloseIntent(
      intent({
        operations: [tokenTransfer(), tokenTransfer()],
        guarantees: { mergeDestination: null, paymentsOnlyTo: [], minXlmFromConversions: null },
      }),
      chosenToken()
    )
  ).toThrow(/only operation/);
  expect(() =>
    assertCloseIntent(exitOnly(tokenTransfer({ source: ATTACKER })), chosenToken())
  ).toThrow(/other than the one being closed/);
  expect(() => assertCloseIntent(exitOnly(tokenTransfer(), "20000000"), chosenToken())).toThrow(
    /network fee/
  );
});

test("a token the user never chose to transfer is judged as a DeFi exit, and fails there: no position, no balance", () => {
  expect(() => assertCloseIntent(exitOnly(tokenTransfer()), expectation())).toThrow(
    /not one of this account's detected positions/
  );
});

// ─── Soroban token conversions (#161) ────────────────────────────────────────

const CONVERT_TOKEN = "CBI7UCH5KGSVQRO5H4SUCZUTZABCITZLRHQQZTWL2TK4RZ72TAR6IHRV";
const OTHER_TOKEN = "CC64WBDGS6QQP22QTTIACYIXT3WF7BBQEYOQPLTP7GTKYY7PZ74QYGSL";
const XLM_CONTRACT = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
const FLOOR = "520000000";

/** A router swap as the Soroswap API renders it in an intent: five arguments, path first hop. */
const routerSwap = (over: Partial<ExitOp> = {}): IntentOperation => ({
  source: SRC,
  type: "invoke_host_function",
  contract: SOROSWAP_ROUTER,
  function: "swap_exact_tokens_for_tokens",
  args: ["100000000", FLOOR, JSON.stringify([CONVERT_TOKEN, XLM_CONTRACT]), SRC, "1788846802"],
  accountsReferenced: [SRC],
  contractsReferenced: [SOROSWAP_ROUTER, CONVERT_TOKEN, XLM_CONTRACT],
  unsupportedAddressCount: 0,
  authorizesBeyondSelf: false,
  authDepth: 1,
  subInvocations: [],
  ...over,
});

/** The aggregator shape: `swap_exact_in(user, token_in, amount_in, token_out, min_out, routes, partner)`. */
const aggregatorArgs = (
  over: { user?: string; out?: string; min?: string; partner?: string } = {}
) => [
  over.user ?? SRC,
  CONVERT_TOKEN,
  "100000000",
  over.out ?? XLM_CONTRACT,
  over.min ?? FLOOR,
  "[]",
  over.partner ?? "null",
];
const aggregatorSwap = (over: Partial<ExitOp> = {}): IntentOperation =>
  routerSwap({ function: "swap_exact_in", args: aggregatorArgs(), ...over });

const chosenConversion = (floor = FLOOR, amountIn = "100000000") =>
  expectation({
    tokenConversions: { [CONVERT_TOKEN]: { minAmountOut: floor, amountOut: floor, amountIn } },
    xlmContract: XLM_CONTRACT,
  });

test("a swap of the token the user chose, paying this account at or above the minimum they saw, passes in both shapes", () => {
  expect(() => assertCloseIntent(exitOnly(routerSwap()), chosenConversion())).not.toThrow();
  expect(() => assertCloseIntent(exitOnly(aggregatorSwap()), chosenConversion())).not.toThrow();
  // More XLM than promised is not a loss.
  const better = routerSwap({
    args: ["100000000", "530000000", JSON.stringify([CONVERT_TOKEN, XLM_CONTRACT]), SRC, "1"],
  });
  expect(() => assertCloseIntent(exitOnly(better), chosenConversion())).not.toThrow();
});

test("rejects a swap that would accept less XLM than the minimum the user was shown", () => {
  const worse = routerSwap({
    args: ["100000000", "519999999", JSON.stringify([CONVERT_TOKEN, XLM_CONTRACT]), SRC, "1"],
  });
  expect(() => assertCloseIntent(exitOnly(worse), chosenConversion())).toThrow(
    /less XLM than the minimum/
  );
  const worseAggregator = aggregatorSwap({ args: aggregatorArgs({ min: "1" }) });
  expect(() => assertCloseIntent(exitOnly(worseAggregator), chosenConversion())).toThrow(
    /less XLM than the minimum/
  );
});

test("rejects a swap that would buy something other than XLM - the floor is meaningless in any other unit", () => {
  const other = "CC64WBDGS6QQP22QTTIACYIXT3WF7BBQEYOQPLTP7GTKYY7PZ74QYGSL";
  const wrongOutputRouter = routerSwap({
    args: ["100000000", FLOOR, JSON.stringify([CONVERT_TOKEN, other]), SRC, "1"],
  });
  expect(() => assertCloseIntent(exitOnly(wrongOutputRouter), chosenConversion())).toThrow(
    /something other than XLM/
  );
  const wrongOutputAggregator = aggregatorSwap({ args: aggregatorArgs({ out: other }) });
  expect(() => assertCloseIntent(exitOnly(wrongOutputAggregator), chosenConversion())).toThrow(
    /something other than XLM/
  );
});

test("rejects a swap that spends less of the token than the balance the user was shown", () => {
  const shortfall = routerSwap({
    args: ["99999999", FLOOR, JSON.stringify([CONVERT_TOKEN, XLM_CONTRACT]), SRC, "1"],
  });
  expect(() =>
    assertCloseIntent(exitOnly(shortfall), chosenConversion(FLOOR, "100000000"))
  ).toThrow(/less of the token/);
  // Spending more than the balance shown is not a loss - the account simply held more.
  const more = routerSwap({
    args: ["100000001", FLOOR, JSON.stringify([CONVERT_TOKEN, XLM_CONTRACT]), SRC, "1"],
  });
  expect(() => assertCloseIntent(exitOnly(more), chosenConversion())).not.toThrow();
});

test("rejects a swap that pays the proceeds anywhere but the account being closed", () => {
  const diverted = routerSwap({
    args: ["100000000", FLOOR, JSON.stringify([CONVERT_TOKEN, XLM_CONTRACT]), ATTACKER, "1"],
    accountsReferenced: [SRC, ATTACKER],
  });
  expect(() => assertCloseIntent(exitOnly(diverted), chosenConversion())).toThrow(
    /other than the account being closed/
  );
  const divertedAggregator = aggregatorSwap({
    args: aggregatorArgs({ user: ATTACKER }),
    accountsReferenced: [SRC, ATTACKER],
  });
  expect(() => assertCloseIntent(exitOnly(divertedAggregator), chosenConversion())).toThrow(
    /other than the account being closed/
  );
});

test("rejects an aggregator swap that names a fee partner", () => {
  const withPartner = aggregatorSwap({ args: aggregatorArgs({ partner: '{"bps":25,"id":"x"}' }) });
  expect(() => assertCloseIntent(exitOnly(withPartner), chosenConversion())).toThrow(
    /arguments could not be read/
  );
});

test("rejects a swap of a token the user never chose to convert", () => {
  const other = "CC64WBDGS6QQP22QTTIACYIXT3WF7BBQEYOQPLTP7GTKYY7PZ74QYGSL";
  const wrongToken = routerSwap({
    args: ["100000000", FLOOR, JSON.stringify([other, XLM_CONTRACT]), SRC, "1"],
  });
  expect(() => assertCloseIntent(exitOnly(wrongToken), chosenConversion())).toThrow(
    /token you did not choose to convert/
  );
  // With no conversion chosen at all, a call on the swap contract is refused the same way: the
  // rule is keyed on the user's decision, not on the contract having been recognized.
  expect(() => assertCloseIntent(exitOnly(routerSwap()), expectation())).toThrow(
    /token you did not choose to convert/
  );
  // And a swap contract the bundled registry does not name is judged as an exit, and fails there.
  expect(() =>
    assertCloseIntent(exitOnly(routerSwap()), expectation({ conversionContracts: [] }))
  ).toThrow(/not one of this account's detected positions/);
});

test("rejects a swap that is not alone, acts for another account, calls another function, or pays an outsized fee", () => {
  expect(() =>
    assertCloseIntent(
      intent({
        operations: [routerSwap(), routerSwap()],
        guarantees: { mergeDestination: null, paymentsOnlyTo: [], minXlmFromConversions: null },
      }),
      chosenConversion()
    )
  ).toThrow(/only operation/);
  expect(() =>
    assertCloseIntent(exitOnly(routerSwap({ source: ATTACKER })), chosenConversion())
  ).toThrow(/other than the one being closed/);
  // A non-swap call on the swap contract is judged as an exit, and fails there unless the account
  // actually holds a position that contract leaves.
  expect(() =>
    assertCloseIntent(exitOnly(routerSwap({ function: "remove_liquidity" })), chosenConversion())
  ).toThrow(/not one of this account's detected positions/);
  // swap_exact_out carries the same seven arguments with the amounts meaning (max_in,
  // amount_out), so reading it as an exact-in swap would hold the wrong figures to the balance
  // and the floor. The function name is what stops it.
  expect(() =>
    assertCloseIntent(exitOnly(aggregatorSwap({ function: "swap_exact_out" })), chosenConversion())
  ).toThrow(/not one of this account's detected positions/);
  expect(() => assertCloseIntent(exitOnly(routerSwap(), "20000000"), chosenConversion())).toThrow(
    /network fee/
  );
});

test("rejects a swap whose arguments cannot be read, or that authorizes beyond the account's own calls", () => {
  for (const args of [
    [],
    ["1", "2", "3"],
    ["1", FLOOR, "not json", SRC, "1"],
    ["1", "x", "[]", SRC, "1"],
  ]) {
    expect(() => assertCloseIntent(exitOnly(routerSwap({ args })), chosenConversion())).toThrow(
      /arguments could not be read|other than a swap/
    );
  }
  expect(() =>
    assertCloseIntent(exitOnly(routerSwap({ authorizesBeyondSelf: true })), chosenConversion())
  ).toThrow(/beyond this account's own contract calls/);
  expect(() =>
    assertCloseIntent(exitOnly(routerSwap({ unsupportedAddressCount: 1 })), chosenConversion())
  ).toThrow(/cannot be verified/);
  expect(() =>
    assertCloseIntent(
      exitOnly(routerSwap({ accountsReferenced: [SRC, ATTACKER] })),
      chosenConversion()
    )
  ).toThrow(/other than the one being closed/);
});

/**
 * The Soroswap router is both the contract a token conversion enters through and the contract a
 * Soroswap LP exit calls `remove_liquidity` on. Every fixture above sets one of the two lists
 * empty, so the collision never appeared in a test - and in production, where both are filled
 * from the bundled registry, the swap rules claimed the exit and rejected it as a malformed
 * swap. No Soroswap position could be closed from the browser.
 */
test("a Soroswap exit through a router that is also a conversion contract passes", () => {
  const bothRoles = expectation({
    conversionContracts: [SOROSWAP_ROUTER],
    exitContracts: [POOL, SOROSWAP_ROUTER],
    exitFunctions: { [POOL]: ["submit"], [SOROSWAP_ROUTER]: ["remove_liquidity"] },
    positionTokenContracts: [CONVERT_TOKEN, XLM_CONTRACT],
  });
  const removeLiquidity = routerSwap({
    function: "remove_liquidity",
    args: [CONVERT_TOKEN, XLM_CONTRACT, "396671711", "1", "1", SRC, "1788846802"],
    authDepth: 0,
  });

  expect(() => assertCloseIntent(exitOnly(removeLiquidity), bothRoles)).not.toThrow();
});

test("the dual role does not let a swap skip the conversion rules", () => {
  // Same contract, same expectation - but a swap still has to satisfy every swap rule, so one
  // the user never chose is refused rather than waved through as an exit.
  const bothRoles = expectation({
    conversionContracts: [SOROSWAP_ROUTER],
    exitContracts: [POOL, SOROSWAP_ROUTER],
    exitFunctions: { [POOL]: ["submit"], [SOROSWAP_ROUTER]: ["remove_liquidity"] },
    xlmContract: XLM_CONTRACT,
  });

  expect(() => assertCloseIntent(exitOnly(routerSwap()), bothRoles)).toThrow(
    /token you did not choose to convert/
  );
});

test("the dual role does not admit a function that is neither a swap nor that protocol's exit", () => {
  const bothRoles = expectation({
    conversionContracts: [SOROSWAP_ROUTER],
    exitContracts: [POOL, SOROSWAP_ROUTER],
    exitFunctions: { [POOL]: ["submit"], [SOROSWAP_ROUTER]: ["remove_liquidity"] },
  });

  expect(() =>
    assertCloseIntent(exitOnly(routerSwap({ function: "add_liquidity" })), bothRoles)
  ).toThrow(/function LumenWipe does not use to leave this protocol/);
});

// ─── xBull's strict_send swap shape (Task 8) ─────────────────────────────────

// The registry's mainnet xBull router: the one other contract a conversion may be entered
// through. Distinct from SOROSWAP_ROUTER so a test can tell which branch actually ran.
const XBULL_ROUTER = "CBXBULLROUTERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY";

/** xBull's PathPayment router call as it renders in an intent: six arguments, the path and refs
 *  both JSON-encoded index/tuple lists. Unlike Soroswap's shape, no argument names the asset
 *  being bought or sold: the tokens are read through `expected.xbullAssets`, where index 1 is
 *  CONVERT_TOKEN and index 0 is XLM. */
const xbullSwap = (over: Partial<ExitOp> = {}): IntentOperation =>
  exit({
    contract: XBULL_ROUTER,
    function: "strict_send",
    args: [SRC, SRC, "100000000", FLOOR, "[[0,1,0,0]]", "[]"],
    contractsReferenced: [XBULL_ROUTER],
    ...over,
  });

const chosenXBullConversion = (
  resolvedPath: string[] = [CONVERT_TOKEN, XLM_CONTRACT],
  floor = FLOOR,
  amountIn = "100000000"
) =>
  expectation({
    conversionContracts: [XBULL_ROUTER],
    tokenConversions: {
      [CONVERT_TOKEN]: { minAmountOut: floor, amountOut: floor, amountIn, resolvedPath },
    },
    xlmContract: XLM_CONTRACT,
  });

test("a strict_send swap whose resolved path matches the chosen token and XLM passes", () => {
  expect(() => assertCloseIntent(exitOnly(xbullSwap()), chosenXBullConversion())).not.toThrow();
  // More XLM than promised is not a loss.
  const better = xbullSwap({ args: [SRC, SRC, "100000000", "530000000", "[[0,1,0,0]]", "[]"] });
  expect(() => assertCloseIntent(exitOnly(better), chosenXBullConversion())).not.toThrow();
});

test("rejects a strict_send swap whose route does not end at XLM", () => {
  const toOther = xbullSwap({ args: [SRC, SRC, "100000000", FLOOR, "[[0,1,0,2]]", "[]"] });
  expect(() => assertCloseIntent(exitOnly(toOther), chosenXBullConversion())).toThrow(
    /something other than XLM/
  );
});

test("refuses a strict_send call whose refs is non-empty even before reaching resolvedPath", () => {
  const withRef = xbullSwap({
    args: [SRC, SRC, "100000000", FLOOR, "[[0,1,0,0]]", `[["${SRC}","100"]]`],
  });
  expect(() => assertCloseIntent(exitOnly(withRef), chosenXBullConversion())).toThrow(
    /referral fee/
  );
});

test("rejects a strict_send swap that would accept less XLM than the minimum the user was shown", () => {
  const worse = xbullSwap({ args: [SRC, SRC, "100000000", "519999999", "[[0,1,0,0]]", "[]"] });
  expect(() => assertCloseIntent(exitOnly(worse), chosenXBullConversion())).toThrow(
    /less XLM than the minimum/
  );
});

test("rejects a strict_send swap that spends less of the token than the balance the user was shown", () => {
  const shortfall = xbullSwap({
    args: [SRC, SRC, "99999999", FLOOR, "[[0,1,0,0]]", "[]"],
  });
  expect(() =>
    assertCloseIntent(exitOnly(shortfall), chosenXBullConversion(undefined, FLOOR, "100000000"))
  ).toThrow(/less of the token/);
});

test("rejects a strict_send swap that pays the proceeds anywhere but the account being closed", () => {
  const diverted = xbullSwap({
    args: [SRC, ATTACKER, "100000000", FLOOR, "[[0,1,0,0]]", "[]"],
    accountsReferenced: [SRC, ATTACKER],
  });
  expect(() => assertCloseIntent(exitOnly(diverted), chosenXBullConversion())).toThrow(
    /other than the account being closed/
  );
});

test("rejects a strict_send swap whose route spends a token the user did not choose to convert", () => {
  const spendsOther = xbullSwap({ args: [SRC, SRC, "100000000", FLOOR, "[[0,2,0,0]]", "[]"] });
  expect(() => assertCloseIntent(exitOnly(spendsOther), chosenXBullConversion())).toThrow(
    /token you did not choose to convert/
  );
  expect(() =>
    assertCloseIntent(exitOnly(xbullSwap()), expectation({ conversionContracts: [XBULL_ROUTER] }))
  ).toThrow(/token you did not choose to convert/);
});

test("rejects a strict_send swap whose route names an index the bundled table does not hold, or breaks between hops", () => {
  for (const path of ["[[0,7,0,0]]", "[[0,1,0,2],[0,1,3,0]]", "[[0,1,0]]", "[]"]) {
    const swap = xbullSwap({ args: [SRC, SRC, "100000000", FLOOR, path, "[]"] });
    expect(() => assertCloseIntent(exitOnly(swap), chosenXBullConversion())).toThrow(
      VerificationError
    );
  }
  const twoHop = xbullSwap({ args: [SRC, SRC, "100000000", FLOOR, "[[0,1,0,2],[0,2,1,0]]", "[]"] });
  expect(() => assertCloseIntent(exitOnly(twoHop), chosenXBullConversion())).not.toThrow();
});

test("rejects a strict_send swap whose arguments cannot be read", () => {
  for (const args of [
    [],
    ["1", "2", "3"],
    [SRC, SRC, "100000000", FLOOR, "not json", "[]"],
    [SRC, SRC, "x", FLOOR, "[[0,1,0,0]]", "[]"],
  ]) {
    expect(() => assertCloseIntent(exitOnly(xbullSwap({ args })), chosenXBullConversion())).toThrow(
      /arguments could not be read/
    );
  }
});

test("a strict_send swap is held to the same outer swap-shape rules as Soroswap's: alone, own fee, own source, no extra authorization", () => {
  expect(() =>
    assertCloseIntent(
      intent({
        operations: [xbullSwap(), xbullSwap()],
        guarantees: { mergeDestination: null, paymentsOnlyTo: [], minXlmFromConversions: null },
      }),
      chosenXBullConversion()
    )
  ).toThrow(/only operation/);
  expect(() =>
    assertCloseIntent(exitOnly(xbullSwap({ source: ATTACKER })), chosenXBullConversion())
  ).toThrow(/other than the one being closed/);
  expect(() =>
    assertCloseIntent(exitOnly(xbullSwap(), "20000000"), chosenXBullConversion())
  ).toThrow(/network fee/);
  expect(() =>
    assertCloseIntent(exitOnly(xbullSwap({ authorizesBeyondSelf: true })), chosenXBullConversion())
  ).toThrow(/beyond this account's own contract calls/);
  expect(() =>
    assertCloseIntent(exitOnly(xbullSwap({ unsupportedAddressCount: 1 })), chosenXBullConversion())
  ).toThrow(/cannot be verified/);
  expect(() =>
    assertCloseIntent(
      exitOnly(xbullSwap({ accountsReferenced: [SRC, ATTACKER] })),
      chosenXBullConversion()
    )
  ).toThrow(/other than the one being closed/);
});

// ─── Network fee and expiry ──────────────────────────────────────────────────

test("a classic close may pay up to ten times the base fee per operation", () => {
  const ops = [setOptions(), payment(ISSUER), merge(DEST)];
  const chosen = expectation({
    transfers: { [`USDC:${ISSUER}`]: { destination: ISSUER, amount: "5" } },
  });
  expect(() => assertCloseIntent(intent({ operations: ops, fee: "3000" }), chosen)).not.toThrow();
  expect(() => assertCloseIntent(intent({ operations: ops, fee: "3001" }), chosen)).toThrow(
    /network fee far above/
  );
});

test("a classic close whose fee is paid by a sponsor carries a zero fee and passes", () => {
  expect(() =>
    assertCloseIntent(intent({ operations: [merge(DEST)], fee: "0" }), expectation())
  ).not.toThrow();
});

test("a fee that is not a whole number of stroops is refused", () => {
  expect(() =>
    assertCloseIntent(intent({ operations: [merge(DEST)], fee: "1e3" }), expectation())
  ).toThrow(/fee could not be read/);
});

test("a transaction without an upper time bound is refused", () => {
  for (const maxTime of [null, undefined, "0"]) {
    expect(() =>
      assertCloseIntent(intent({ operations: [merge(DEST)], maxTime }), expectation())
    ).toThrow(/never expires/);
  }
});

test("a transaction may stay valid for at most fifteen minutes from verification", () => {
  const at = (maxTime: number) => intent({ operations: [merge(DEST)], maxTime: String(maxTime) });
  expect(() => assertCloseIntent(at(NOW + 900), expectation())).not.toThrow();
  expect(() => assertCloseIntent(at(NOW + 901), expectation())).toThrow(/far longer/);
});

test("verifyCloseTransaction reads the expiry from the envelope itself", () => {
  const unsignedXdr = (timeout: number) => {
    const builder = new TransactionBuilder(new Account(SRC, "100"), {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    });
    builder.addOperation(Operation.accountMerge({ destination: DEST }));
    return builder.setTimeout(timeout).build().toEnvelope().toXdr("base64");
  };
  const run = (xdrString: string) =>
    verifyCloseTransaction({
      unsignedXdr: xdrString,
      network: "testnet",
      expected: expectation(),
    });
  expect(() => run(unsignedXdr(300))).not.toThrow();
  expect(() => run(unsignedXdr(0))).toThrow(/never expires/);
  expect(() => run(unsignedXdr(3600))).toThrow(/far longer/);
});

test("every operation must act for the account being closed", () => {
  const others: IntentOperation[] = [
    setOptions({ source: ATTACKER }),
    { source: ATTACKER, type: "manage_data", name: "k", value: null },
    { source: ATTACKER, type: "change_trust", asset: `USDC:${ISSUER}`, limit: "0" },
    { source: ATTACKER, type: "manage_sell_offer", offerId: "1", amount: "0" },
    { source: ATTACKER, type: "claim_claimable_balance", balanceId: "00".repeat(36) },
    { source: ATTACKER, type: "revoke_sponsorship", entryKind: "account", owner: ATTACKER },
    { ...conversion(), source: ATTACKER },
  ];
  for (const op of others) {
    expect(() =>
      assertCloseIntent(intent({ operations: [op, merge(DEST)] }), expectation())
    ).toThrow(/^The transaction would act for an account other than the one being closed\.$/);
  }
});

test("a pre-authorized transaction keeps its own expiry and fee", () => {
  const ops = [merge(DEST)];
  const own = intent({ operations: ops, maxTime: null, fee: "5000" });
  expect(() => assertCloseIntent(own, expectation({ preAuthorized: true }))).not.toThrow();
  expect(() => assertCloseIntent(own, expectation())).toThrow(/never expires/);
});

// ─── The mediated hand-off follows the bundled registry ─────────────────────

function mediatedWrapper(destination: string, mediatorRequired: boolean): () => void {
  const intermediary = Keypair.random().publicKey();
  const unsignedXdr = buildXdr([
    Operation.accountMerge({ destination: intermediary }),
    Operation.payment({
      destination,
      asset: Asset.native(),
      amount: "100",
      source: intermediary,
    }),
  ]);
  return () =>
    verifyCloseTransaction({
      unsignedXdr,
      network: "testnet",
      expected: { ...expectation({ destination }), mediatorRequired },
    });
}

test("the mediated hand-off is refused for a destination the bundled registry does not list, whatever the caller says", () => {
  expect(mediatedWrapper(DEST, true)).toThrow(/address you did not choose/);
});

test("a served registry entry cannot make the mediated hand-off reachable for a new address", () => {
  const before = activeRegistry();
  setRegistry({
    ...before,
    served: true,
    entries: [
      ...before.entries,
      {
        address: DEST,
        name: "Served only",
        domain: "example.com",
        requiresMediator: true,
        requiresMemo: false,
        memoType: "text",
      },
    ],
  });
  try {
    expect(mediatedWrapper(DEST, true)).toThrow(/address you did not choose/);
  } finally {
    setRegistry(before);
  }
});

test("a swap floor sits no more than 1% under the quote the user was shown, whatever floor the plan carried", () => {
  // Quote 600 XLM: the floor is at least 594 XLM even when the plan carries a lower one.
  const quoted = (minAmountOut: string, amountOut?: string) =>
    expectation({
      tokenConversions: {
        [CONVERT_TOKEN]: {
          minAmountOut,
          ...(amountOut !== undefined ? { amountOut } : {}),
          amountIn: "100000000",
        },
      },
      xlmContract: XLM_CONTRACT,
    });
  const swapWithMin = (min: string) =>
    exitOnly(
      routerSwap({
        args: ["100000000", min, JSON.stringify([CONVERT_TOKEN, XLM_CONTRACT]), SRC, "1"],
      })
    );
  expect(() =>
    assertCloseIntent(swapWithMin("5940000000"), quoted("1", "6000000000"))
  ).not.toThrow();
  expect(() => assertCloseIntent(swapWithMin("5939999999"), quoted("1", "6000000000"))).toThrow(
    /less XLM than the minimum/
  );
  expect(() => assertCloseIntent(swapWithMin("5940000000"), quoted("1"))).toThrow(
    /quote you were shown/
  );
});

test("a strict_send swap floor also sits no more than 1% under the quote the user was shown", () => {
  const quoted = expectation({
    conversionContracts: [XBULL_ROUTER],
    tokenConversions: {
      [CONVERT_TOKEN]: {
        minAmountOut: "1",
        amountOut: "6000000000",
        amountIn: "100000000",
        resolvedPath: [CONVERT_TOKEN, XLM_CONTRACT],
      },
    },
    xlmContract: XLM_CONTRACT,
  });
  const withMin = (min: string) =>
    exitOnly(xbullSwap({ args: [SRC, SRC, "100000000", min, "[[0,1,0,0]]", "[]"] }));
  expect(() => assertCloseIntent(withMin("5940000000"), quoted)).not.toThrow();
  expect(() => assertCloseIntent(withMin("5939999999"), quoted)).toThrow(
    /less XLM than the minimum/
  );
});

// ─── Classic conversions follow the user's choice and the plan's quote ───────

test("a classic conversion sells only an asset the user chose to convert", () => {
  const i = intent({ operations: [conversion(), merge(DEST)] });
  expect(() => assertCloseIntent(i, expectation({ classicConversions: {} }))).toThrow(
    /did not choose to convert/
  );
});

test("a classic conversion accepts at least the minimum the plan showed", () => {
  const at = (destMin: string) =>
    intent({ operations: [conversion(SRC, "native", destMin), merge(DEST)] });
  expect(() => assertCloseIntent(at("9.0000000"), expectation())).not.toThrow();
  expect(() => assertCloseIntent(at("8.9999999"), expectation())).toThrow(
    /less XLM than the minimum you were shown/
  );
  expect(() => assertCloseIntent(at("0.0000001"), expectation())).toThrow(
    /less XLM than the minimum you were shown/
  );
});

test("an asset only an exit pays in is held to the user's choice and a positive minimum", () => {
  const chosen = expectation({
    classicConversions: { [`USDC:${ISSUER}`]: { minAmountOut: null } },
  });
  const i = intent({ operations: [conversion(SRC, "native", "0.0000001"), merge(DEST)] });
  expect(() => assertCloseIntent(i, chosen)).not.toThrow();
});

test("an asset is converted at most once per transaction", () => {
  const i = intent({ operations: [conversion(), conversion(), merge(DEST)] });
  expect(() => assertCloseIntent(i, expectation())).toThrow(/convert USDC more than once/);
});

test("a classic conversion of XLM itself, or of an asset the user chose to send elsewhere, is refused", () => {
  const nativeSale: IntentOperation = {
    source: SRC,
    type: "path_payment_strict_send",
    sendAsset: "native",
    sendAmount: "10",
    destination: SRC,
    destAsset: "native",
    destMin: "9",
    path: [],
  };
  const native = intent({ operations: [nativeSale, merge(DEST)] });
  expect(() => assertCloseIntent(native, expectation())).toThrow(/did not choose to convert/);
  const kept = intent({ operations: [conversion(SRC, "native", "9.0000000"), merge(DEST)] });
  expect(() =>
    assertCloseIntent(
      kept,
      expectation({
        classicConversions: {},
        transfers: { [`USDC:${ISSUER}`]: { destination: DEST, amount: "10" } },
      })
    )
  ).toThrow(/did not choose to convert/);
});

// ─── Exits outside the registry and what a swap authorizes ───────────────────

test("an exit through a contract outside the bundled registry may not touch XLM or a classic asset", () => {
  const SHARE = "CAN7DMIQH7FGKNYCUQMWECJJ74EKN5JATVVUOVTXOWLQGZCWAFWANG5P";
  const unregistered = expectation({
    heldTokenContracts: [XLM_SAC],
    positionTokenContracts: [SHARE],
    protectedTokenContracts: [XLM_SAC],
    registryContracts: [],
  });
  for (const sub of [
    { contract: XLM_SAC, function: "transfer", args: [SRC, POOL, "100"] },
    { contract: XLM_SAC, function: "approve", args: [SRC, POOL, "100", "1000"] },
    { contract: XLM_SAC, function: "burn", args: [SRC, "100"] },
  ]) {
    const op = exit({ contractsReferenced: [POOL, XLM_SAC], subInvocations: [sub] });
    expect(() => assertCloseIntent(exitOnly(op), unregistered)).toThrow(/has not verified/);
    expect(() =>
      assertCloseIntent(exitOnly(op), { ...unregistered, registryContracts: [POOL] })
    ).not.toThrow();
  }
  const shareBack = exit({
    contractsReferenced: [POOL, SHARE],
    subInvocations: [{ contract: SHARE, function: "transfer", args: [SRC, POOL, "100"] }],
  });
  expect(() =>
    assertCloseIntent(exitOnly(shareBack), {
      ...unregistered,
      ownTokensByContract: { [POOL]: [SHARE] },
    })
  ).not.toThrow();
  // Another position's token, or a token the account merely holds, stays out of its reach.
  expect(() => assertCloseIntent(exitOnly(shareBack), unregistered)).toThrow(/has not verified/);
  expect(() =>
    assertCloseIntent(exitOnly(shareBack), {
      ...unregistered,
      positionTokenContracts: [],
      heldTokenContracts: [XLM_SAC, SHARE],
      ownTokensByContract: { [POOL]: [] },
    })
  ).toThrow(/has not verified/);
});

test("a swap may authorize only paying in the token it sells, from this account, up to the amount it sells", () => {
  const withSubs = (subInvocations: { contract: string; function: string; args: string[] }[]) =>
    exitOnly(routerSwap({ subInvocations }));
  const PAIR = "CB46LMGJFTHSOVT7B2HV7JLQ5Y3UT4R4UVQIIQ3RDYALS4Y47YC5UPQI";
  expect(() =>
    assertCloseIntent(
      withSubs([{ contract: CONVERT_TOKEN, function: "transfer", args: [SRC, PAIR, "100000000"] }]),
      chosenConversion()
    )
  ).not.toThrow();
  for (const sub of [
    { contract: XLM_CONTRACT, function: "transfer", args: [SRC, PAIR, "1"] },
    { contract: CONVERT_TOKEN, function: "approve", args: [SRC, PAIR, "1", "1"] },
    { contract: CONVERT_TOKEN, function: "transfer", args: [SRC, DEST, "1"] },
    { contract: CONVERT_TOKEN, function: "transfer", args: [ATTACKER, PAIR, "1"] },
    { contract: PAIR, function: "withdraw", args: [] },
  ]) {
    expect(() => assertCloseIntent(withSubs([sub]), chosenConversion())).toThrow(
      /other than paying in the token/
    );
  }
  expect(() =>
    assertCloseIntent(
      withSubs([{ contract: CONVERT_TOKEN, function: "transfer", args: [SRC, PAIR, "100000001"] }]),
      chosenConversion()
    )
  ).toThrow(/more than the balance it sells/);
  expect(() =>
    assertCloseIntent(
      withSubs([
        { contract: PAIR, function: "swap", args: [] },
        { contract: CONVERT_TOKEN, function: "transfer", args: [SRC, PAIR, "100000000"] },
      ]),
      chosenConversion()
    )
  ).not.toThrow();
  expect(() =>
    assertCloseIntent(
      withSubs([{ contract: XLM_CONTRACT, function: "swap", args: [] }]),
      chosenConversion()
    )
  ).toThrow(/other than paying in the token/);
});

type ExitExpected = Parameters<typeof verifyCloseTransaction>[0]["expected"];

const MAX_EXIT_FEE_STROOPS = 10_000_000;
const OUTSIDER_CONTRACT = StrKey.encodeContract(hash(Buffer.from("outsider contract")));

function realExitExpectation(fixture: RealExitEnvelope, account = fixture.account): ExitExpected {
  return {
    source: account.address,
    destination: DEST,
    mediatorRequired: false,
    nativeBalance: account.nativeBalanceLumens,
    memo: null,
    claimTrustlineAssets: [],
    accountSigners: account.signers,
    accountThresholds: account.thresholds,
    transfers: {},
    tokenTransfers: {},
    classicConversions: {},
    tokenConversions: {},
    ...exitExpectations(account, "testnet"),
  };
}

type Writable<T> = { -readonly [K in keyof T]: T[K] };
type MutableCall = Omit<Writable<xdr.InvokeContractArgs>, "functionName"> & {
  functionName: xdr.InvokeContractArgs["functionName"] | string;
};

/** The real envelope, with `change` applied to its decoded body. Signatures stay out of it: the
 *  fixtures are unsigned. */
function mutatedEnvelope(
  fixture: RealExitEnvelope,
  change: (tx: Writable<xdr.Transaction>, op: xdr.InvokeHostFunctionOp) => void
): string {
  const envelope = xdr.TransactionEnvelope.fromXdr(fixture.xdr, "base64");
  if (envelope.type !== "envelopeTypeTx") throw new Error("not a v1 envelope");
  const { tx } = envelope.v1;
  const { body } = tx.operations[0]!;
  if (body.type !== "invokeHostFunction") throw new Error("not a contract call");
  change(tx, body.invokeHostFunctionOp);
  return envelope.toXdr("base64");
}

function contractCall(node: xdr.SorobanAuthorizedInvocation): MutableCall {
  if (node.function.type !== "sorobanAuthorizedFunctionTypeContractFn") {
    throw new Error("not a contract call");
  }
  return node.function.contractFn;
}

/** The operation's call and the root of its authorization: an altered call has to change both,
 *  or the verdict would come from the two disagreeing. */
function rootCalls(op: xdr.InvokeHostFunctionOp): MutableCall[] {
  if (op.hostFunction.type !== "hostFunctionTypeInvokeContract") {
    throw new Error("not a contract call");
  }
  return [op.hostFunction.invokeContract, contractCall(op.auth[0]!.rootInvocation)];
}

function tokenCall(op: xdr.InvokeHostFunctionOp): MutableCall {
  return contractCall(op.auth[0]!.rootInvocation.subInvocations[0]!);
}

const redirectTokenCallTo = (fixture: RealExitEnvelope, recipient: string): string =>
  mutatedEnvelope(fixture, (_tx, op) => {
    const call = tokenCall(op);
    call.functionName = "transfer";
    call.args = [
      new Address(fixture.expected.source).toScVal(),
      new Address(recipient).toScVal(),
      nativeToScVal(BigInt(1), { type: "i128" }),
    ];
  });

function verifyReal(
  fixture: RealExitEnvelope,
  unsignedXdr: string,
  expected = realExitExpectation(fixture)
): void {
  verifyCloseTransaction({ unsignedXdr, network: "testnet", expected });
}

for (const fixture of REAL_EXIT_ENVELOPES) {
  describe(`real exit envelope: ${fixture.name}`, () => {
    // verify() reads the clock for the expiry, and the bundled registries expire: pinned to the
    // moment each envelope was built, these tests pass on any later date.
    beforeEach(() => {
      setSystemTime(new Date((Number(fixture.expected.maxTime) - 300) * 1000));
    });
    afterEach(() => {
      setSystemTime();
    });

    test("decodes to the fields recorded with it", () => {
      const { expected } = fixture;
      const transaction = TransactionBuilder.fromXdr(fixture.xdr, Networks.TESTNET);
      expect(toHex(transaction.hash())).toBe(expected.hash);

      const decoded = intentFromXdr(fixture.xdr, Networks.TESTNET);
      expect(decoded).toMatchObject({
        source: expected.source,
        fee: expected.fee,
        maxTime: expected.maxTime,
      });
      expect(decoded.operations).toHaveLength(1);
      const [op] = decoded.operations;
      if (op?.type !== "invoke_host_function") throw new Error("not a contract call");
      expect(op.contract).toBe(expected.contract);
      expect(op.function).toBe(expected.function);
      expect(op.subInvocations.map((sub) => [sub.contract, sub.function])).toEqual([
        [expected.tokenCall.contract, expected.tokenCall.function],
      ]);
    });

    test("is accepted against the expectation derived from its account read", () => {
      expect(() => verifyReal(fixture, fixture.xdr)).not.toThrow();
    });

    test("is accepted at the fee cap", () => {
      const atCap = mutatedEnvelope(fixture, (tx) => {
        tx.fee = MAX_EXIT_FEE_STROOPS;
      });
      expect(() => verifyReal(fixture, atCap)).not.toThrow();
    });

    test("rejects a changed root contract", () => {
      const altered = mutatedEnvelope(fixture, (_tx, op) => {
        const outsider = new Address(OUTSIDER_CONTRACT).toScAddress();
        for (const call of rootCalls(op)) call.contractAddress = outsider;
      });
      expect(() => verifyReal(fixture, altered)).toThrow(/not one of this account's detected/);
    });

    test("rejects a changed root function", () => {
      const altered = mutatedEnvelope(fixture, (_tx, op) => {
        for (const call of rootCalls(op)) call.functionName = "upgrade";
      });
      expect(() => verifyReal(fixture, altered)).toThrow(/does not use to leave this protocol/);
    });

    test("rejects a token call paying a third-party account", () => {
      expect(() => verifyReal(fixture, redirectTokenCallTo(fixture, ATTACKER))).toThrow(
        /would send funds to, or act for, an account other than the one being closed/
      );
    });

    test("rejects a token call paying a contract the exit may name but not pay", () => {
      const { xlmContract } = realExitExpectation(fixture);
      expect(() => verifyReal(fixture, redirectTokenCallTo(fixture, xlmContract))).toThrow(
        /move a token balance to an address other than this account or the protocol/
      );
    });

    test("rejects a token call paying a contract outside the account read", () => {
      expect(() => verifyReal(fixture, redirectTokenCallTo(fixture, OUTSIDER_CONTRACT))).toThrow(
        /has no position, balance, or pool token in/
      );
    });

    test("rejects a changed sub-invocation function", () => {
      const altered = mutatedEnvelope(fixture, (_tx, op) => {
        tokenCall(op).functionName = "mint";
      });
      expect(() => verifyReal(fixture, altered)).toThrow(/function on a token/);
    });

    test("rejects a sub-invocation function its arguments do not fit", () => {
      const altered = mutatedEnvelope(fixture, (_tx, op) => {
        tokenCall(op).functionName = "approve";
      });
      expect(() => verifyReal(fixture, altered)).toThrow(/does not match its real signature/);
    });

    test("rejects an extra operation", () => {
      const altered = mutatedEnvelope(fixture, (tx) => {
        const extra = Operation.payment({
          destination: ATTACKER,
          asset: Asset.native(),
          amount: "1",
        });
        tx.operations = [...tx.operations, extra];
      });
      expect(() => verifyReal(fixture, altered)).toThrow(/must be the only operation/);
    });

    test("rejects a fee over the cap", () => {
      const altered = mutatedEnvelope(fixture, (tx) => {
        tx.fee = MAX_EXIT_FEE_STROOPS + 1;
      });
      expect(() => verifyReal(fixture, altered)).toThrow(/network fee far above/);
    });

    test("rejects the envelope once its token leaves the account read", () => {
      const account = {
        ...fixture.account,
        sorobanTokens: { ...fixture.account.sorobanTokens, tokens: [] },
      } as AccountState;
      expect(() => verifyReal(fixture, fixture.xdr, realExitExpectation(fixture, account))).toThrow(
        /has no position, balance, or pool token in/
      );
    });

    // Characterizes a limit, it does not endorse it: the client does not know a protocol's ABI,
    // so verify() checks structure and an exit's amount is the residual in architecture.md
    // section 13. A failure here means that section needs updating.
    test("accepts a changed amount: the residual documented in architecture.md section 13", () => {
      const { rootAmountArg, tokenCall: token } = fixture.expected;
      const changed = nativeToScVal(BigInt(1), { type: "i128" });
      const altered = mutatedEnvelope(fixture, (_tx, op) => {
        for (const call of rootCalls(op)) call.args[rootAmountArg] = changed;
        tokenCall(op).args[token.amountArg] = changed;
      });
      expect(altered).not.toBe(fixture.xdr);
      expect(() => verifyReal(fixture, altered)).not.toThrow();
    });
  });
}
