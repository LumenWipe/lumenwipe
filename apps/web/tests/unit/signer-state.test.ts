import { expect, test } from "bun:test";
import {
  Account,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import type { IntentOperation } from "@/types/close-api";
import {
  applyConfirmedSetOptions,
  applyConfirmedTransaction,
  parseRoundSignerState,
} from "@/lib/stellar/signature-weight";

const SOURCE = Keypair.random().publicKey();
const COSIGNER = Keypair.random().publicKey();
const OTHER = Keypair.random().publicKey();

const MULTISIG = {
  signers: [
    { key: SOURCE, weight: 1, type: "ed25519_public_key" as const },
    { key: COSIGNER, weight: 1, type: "ed25519_public_key" as const },
  ],
  thresholds: { low: 1, med: 2, high: 2 },
};

function setOptions(
  over: Partial<Extract<IntentOperation, { type: "set_options" }>>
): IntentOperation {
  return {
    type: "set_options",
    source: SOURCE,
    signer: null,
    masterWeight: null,
    lowThreshold: null,
    medThreshold: null,
    highThreshold: null,
    homeDomain: null,
    setFlags: null,
    clearFlags: null,
    inflationDest: null,
    ...over,
  };
}

test("parseRoundSignerState › accepts a well-formed state and copies only the known fields", () => {
  const parsed = parseRoundSignerState({
    signers: [{ ...MULTISIG.signers[0], extra: "x" }],
    thresholds: { ...MULTISIG.thresholds, extra: 1 },
  });
  expect(parsed).toEqual({ signers: [MULTISIG.signers[0]!], thresholds: MULTISIG.thresholds });
});

test("parseRoundSignerState › anything malformed is ignored rather than trusted", () => {
  expect(parseRoundSignerState(undefined)).toBeNull();
  expect(parseRoundSignerState({ signers: MULTISIG.signers })).toBeNull();
  expect(
    parseRoundSignerState({ ...MULTISIG, thresholds: { low: 0, med: -1, high: 1 } })
  ).toBeNull();
  expect(
    parseRoundSignerState({ ...MULTISIG, thresholds: { low: 0, med: 1, high: 256 } })
  ).toBeNull();
  expect(
    parseRoundSignerState({ ...MULTISIG, signers: [{ key: SOURCE, weight: 1, type: "other" }] })
  ).toBeNull();
  expect(
    parseRoundSignerState({ ...MULTISIG, signers: [{ key: SOURCE, weight: "1", type: "hash_x" }] })
  ).toBeNull();
});

test("applyConfirmedSetOptions › signer normalization removes the cosigner and lowers the thresholds", () => {
  const next = applyConfirmedSetOptions(
    MULTISIG,
    [
      setOptions({ signer: { key: COSIGNER, weight: 0, type: "ed25519_public_key" } }),
      setOptions({ lowThreshold: 0, medThreshold: 1, highThreshold: 1 }),
    ],
    SOURCE
  );
  expect(next).toEqual({
    signers: [MULTISIG.signers[0]!],
    thresholds: { low: 0, med: 1, high: 1 },
  });
});

test("applyConfirmedSetOptions › master weight, a reweighted signer and untouched thresholds", () => {
  const next = applyConfirmedSetOptions(
    MULTISIG,
    [
      setOptions({
        masterWeight: 3,
        signer: { key: COSIGNER, weight: 2, type: "ed25519_public_key" },
      }),
      setOptions({ highThreshold: 3 }),
    ],
    SOURCE
  );
  expect(next.signers).toContainEqual({ key: SOURCE, weight: 3, type: "ed25519_public_key" });
  expect(next.signers).toContainEqual({ key: COSIGNER, weight: 2, type: "ed25519_public_key" });
  expect(next.thresholds).toEqual({ low: 1, med: 2, high: 3 });
  expect(
    applyConfirmedSetOptions(MULTISIG, [setOptions({ masterWeight: 0 })], SOURCE).signers
  ).toEqual([MULTISIG.signers[1]!]);
});

test("applyConfirmedSetOptions › operations for another account or of another type change nothing", () => {
  const ops: IntentOperation[] = [
    { ...setOptions({ highThreshold: 0 }), source: OTHER },
    { type: "account_merge", destination: OTHER, source: SOURCE },
  ];
  expect(applyConfirmedSetOptions(MULTISIG, ops, SOURCE)).toEqual(MULTISIG);
});

test("parseRoundSignerState › a key that does not decode for its type, or appears twice, is refused", () => {
  expect(
    parseRoundSignerState({
      ...MULTISIG,
      signers: [{ key: "GNOTAKEY", weight: 1, type: "ed25519_public_key" }],
    })
  ).toBeNull();
  expect(
    parseRoundSignerState({ ...MULTISIG, signers: [{ key: SOURCE, weight: 1, type: "hash_x" }] })
  ).toBeNull();
  expect(
    parseRoundSignerState({ ...MULTISIG, signers: [MULTISIG.signers[0], MULTISIG.signers[0]] })
  ).toBeNull();
});

test("applyConfirmedTransaction › the pre-authorized signer a transaction matched is gone once it applies", () => {
  const xdr = new TransactionBuilder(new Account(SOURCE, "1"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.bumpSequence({ bumpTo: "5" }))
    .setTimeout(300)
    .build()
    .toXDR();
  const preAuth = {
    key: StrKey.encodePreAuthTx(TransactionBuilder.fromXDR(xdr, Networks.TESTNET).hash()),
    weight: 1,
    type: "preauth_tx" as const,
  };
  const state = { ...MULTISIG, signers: [...MULTISIG.signers, preAuth] };
  expect(applyConfirmedTransaction(state, xdr, Networks.TESTNET, [], SOURCE)).toEqual(MULTISIG);
});
