/**
 * Writes `vectors/close-v1.json`, the conformance vector set, or with `--check` fails when the
 * committed file differs from what this script builds.
 *
 *   bun scripts/generate-vectors.ts          regenerate
 *   bun scripts/generate-vectors.ts --check  compare only (run by the package tests)
 *
 * Every transaction is built here from fixed inputs, so the output is byte-for-byte stable. Keys
 * come from fixed seeds and only their public halves are ever written; the file holds no secret.
 * Every rejection is one named mutation of an accepted vector, and its expected code and message are
 * written by hand below, never captured from a run of the verifier.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  Account,
  Asset,
  hash,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { REAL_EXIT_ENVELOPES } from "../../../apps/web/tests/unit/fixtures/real-exit-envelopes";
import {
  exitExpectations,
  type AccountState,
  type CloseExpectationInput,
  type ServedRegistry,
  type VerificationErrorCode,
  type VerifyCloseInput,
} from "../src/index";

export const VECTORS_PATH = fileURLToPath(new URL("../vectors/close-v1.json", import.meta.url));

/** The clock every synthetic vector is verified at: 2026-11-01T00:00:00Z. */
const NOW = 1_793_491_200;

/** A public key from a fixed seed. The seed is derived from the label; only the public key is
 *  returned, so no secret can reach the file. */
function publicKey(label: string): string {
  return Keypair.fromRawEd25519Seed(hash(Buffer.from(`lumenwipe close-v1 ${label}`))).publicKey();
}

const SOURCE = publicKey("source");
const DESTINATION = publicKey("destination");
const ATTACKER = publicKey("attacker");
const OTHER_ACCOUNT = publicKey("other account");
const INTERMEDIARY = publicKey("intermediary");
const COSIGNER = publicKey("cosigner");
const NEW_SIGNER = publicKey("new signer");
const FRIEND = publicKey("friend");
const ISSUER = publicKey("issuer");
/** A listed exchange in the bundled registry that needs the intermediary and a text memo. */
const COINBASE = "GB5CLRWUCBQ6DFK2LR5ZMWJ7QCVEB3XKMPTQUYCDIYB4DRZJBEW6M26D";

const USDC = new Asset("USDC", ISSUER);
const EURT = new Asset("EURT", ISSUER);
const USDC_KEY = `USDC:${ISSUER}`;
const BALANCE_ID = `00000000${"ab".repeat(32)}`;

interface BuildOptions {
  source?: string;
  /** Per-operation base fee in stroops; the transaction's fee is this times the operations. */
  feePerOperation?: number;
  memo?: Memo;
  maxTime?: number;
}

function build(operations: xdr.Operation[], options: BuildOptions = {}): string {
  const builder = new TransactionBuilder(new Account(options.source ?? SOURCE, "4294967296"), {
    fee: String(options.feePerOperation ?? 100),
    networkPassphrase: Networks.TESTNET,
    timebounds: { minTime: 0, maxTime: options.maxTime ?? NOW + 300 },
    ...(options.memo ? { memo: options.memo } : {}),
  });
  for (const operation of operations) builder.addOperation(operation);
  return builder.build().toEnvelope().toXdr("base64");
}

const signer = (key: string, weight = 1) => ({ key, weight, type: "ed25519_public_key" as const });

/** A plain account read: one master key, no thresholds, no positions. */
const PLAIN_ACCOUNT = {
  address: SOURCE,
  nativeBalanceLumens: "100.0000000",
  signers: [signer(SOURCE)],
  thresholds: { low: 0, med: 0, high: 0 },
  trustlines: [],
  defiPositions: { positions: [] },
} as unknown as AccountState;

/** The expectation an integrator builds from the user's inputs and the reviewed account read. */
function expectation(over: Partial<CloseExpectationInput> = {}): CloseExpectationInput {
  return {
    source: SOURCE,
    destination: DESTINATION,
    nativeBalance: "100.0000000",
    memo: null,
    memoType: null,
    claimTrustlineAssets: [],
    accountSigners: [signer(SOURCE)],
    accountThresholds: { low: 0, med: 0, high: 0 },
    transfers: {},
    tokenTransfers: {},
    classicConversions: {},
    tokenConversions: {},
    ...exitExpectations(PLAIN_ACCOUNT, "testnet"),
    ...over,
  };
}

interface Provenance {
  network: "testnet";
  capturedAt: string;
  adapter: string;
  origin: string;
  limits: string;
  fixture: string;
}

interface AcceptVector {
  name: string;
  verdict: "accept";
  description: string;
  nowSeconds: number;
  provenance?: Provenance;
  input: VerifyCloseInput;
}

interface RejectVector {
  name: string;
  verdict: "reject";
  base: string;
  mutation: string;
  nowSeconds: number;
  input: VerifyCloseInput;
  error: { name: "VerificationError"; code: VerificationErrorCode; message: string };
}

export type Vector = AcceptVector | RejectVector;

export interface VectorFile {
  schema: 1;
  name: "close-v1";
  description: string;
  generator: string;
  vectors: Vector[];
}

const accepts: AcceptVector[] = [];
const rejects: RejectVector[] = [];

function accept(
  name: string,
  description: string,
  unsignedXdr: string,
  expected: CloseExpectationInput,
  extra: { nowSeconds?: number; provenance?: Provenance; servedRegistry?: ServedRegistry } = {}
): AcceptVector {
  const vector: AcceptVector = {
    name,
    verdict: "accept",
    description,
    nowSeconds: extra.nowSeconds ?? NOW,
    ...(extra.provenance ? { provenance: extra.provenance } : {}),
    input: {
      unsignedXdr,
      network: "testnet",
      expected,
      ...(extra.servedRegistry ? { servedRegistry: extra.servedRegistry } : {}),
    },
  };
  accepts.push(vector);
  return vector;
}

function reject(
  base: AcceptVector,
  name: string,
  mutation: string,
  unsignedXdr: string,
  code: VerificationErrorCode,
  message: string
): void {
  rejects.push({
    name,
    verdict: "reject",
    base: base.name,
    mutation,
    nowSeconds: base.nowSeconds,
    input: { ...base.input, unsignedXdr },
    error: { name: "VerificationError", code, message },
  });
}

/** A rejection whose mutation is the served registry snapshot, alone or together with the
 *  transaction (`unsignedXdr`, when given). The expectation and the clock stay the base's. */
function rejectUnderSnapshot(
  base: AcceptVector,
  name: string,
  mutation: string,
  servedRegistry: ServedRegistry,
  code: VerificationErrorCode,
  message: string,
  unsignedXdr: string = base.input.unsignedXdr
): void {
  rejects.push({
    name,
    verdict: "reject",
    base: base.name,
    mutation,
    nowSeconds: base.nowSeconds,
    input: { ...base.input, unsignedXdr, servedRegistry },
    error: { name: "VerificationError", code, message },
  });
}

const merge = (destination = DESTINATION, source?: string) =>
  Operation.accountMerge({ destination, ...(source ? { source } : {}) });

// --- A plain account merged straight to the user's own wallet ---------------------------------

const minimal = accept(
  "minimal-direct-merge",
  "A plain account with no subentries, merged straight to the address the user typed.",
  build([merge()]),
  expectation()
);
reject(
  minimal,
  "unknown-operation",
  "Adds a bump sequence operation, which no close uses.",
  build([Operation.bumpSequence({ bumpTo: "9" }), merge()]),
  "operation_unknown",
  "The transaction contains an unrecognized operation."
);
reject(
  minimal,
  "wrong-merge-destination",
  "Merges to an address the user did not type.",
  build([merge(ATTACKER)]),
  "merge_destination_mismatch",
  "The account would be merged to an address you did not choose."
);
reject(
  minimal,
  "intermediary-for-a-wallet-close",
  "Routes a close to a plain wallet through an intermediary that forwards the whole balance.",
  build([
    merge(INTERMEDIARY),
    Operation.payment({
      destination: DESTINATION,
      asset: Asset.native(),
      amount: "100",
      source: INTERMEDIARY,
    }),
  ]),
  "merge_destination_mismatch",
  "The account would be merged to an address you did not choose."
);
reject(
  minimal,
  "second-merge",
  "Adds a second merge, of another account, into the same destination.",
  build([merge(), merge(DESTINATION, OTHER_ACCOUNT)]),
  "merge_multiple",
  "The transaction would merge more than one account."
);
reject(
  minimal,
  "merge-sent-by-another-account",
  "The merge names another account as its source.",
  build([merge(DESTINATION, OTHER_ACCOUNT)]),
  "operation_source_mismatch",
  "The account merge is not sent by the account being closed."
);
reject(
  minimal,
  "fee-above-classic-cap",
  "Raises the fee to one stroop above 1,000 per operation.",
  build([merge()], { feePerOperation: 1001 }),
  "fee_above_cap",
  "This transaction would pay a network fee far above what its operations need."
);
reject(
  minimal,
  "never-expires",
  "Removes the upper time bound.",
  build([merge()], { maxTime: 0 }),
  "expiry_missing",
  "This transaction never expires, so it could be submitted long after you approved it."
);
reject(
  minimal,
  "valid-too-long",
  "Sets the upper time bound 901 seconds after the clock.",
  build([merge()], { maxTime: NOW + 901 }),
  "expiry_too_far",
  "This transaction stays valid for far longer than a close needs. If your device clock is wrong, correct it and try again."
);
reject(
  minimal,
  "not-for-this-account",
  "Builds the transaction for another source account.",
  build([merge(DESTINATION, SOURCE)], { source: OTHER_ACCOUNT }),
  "transaction_source_mismatch",
  "The transaction is not for your account."
);
reject(
  minimal,
  "memo-not-set",
  "Adds a text memo the user never set.",
  build([merge()], { memo: Memo.text("surprise") }),
  "memo_unexpected",
  "The transaction carries a memo you did not set."
);

// --- An account with subentries -------------------------------------------------------------

const subentries = accept(
  "simple-account-with-subentries",
  "Removes a data entry, cancels an offer and removes an empty trustline, then merges to the user's wallet.",
  build([
    Operation.manageData({ name: "note", value: null }),
    Operation.manageSellOffer({
      selling: USDC,
      buying: Asset.native(),
      amount: "0",
      price: "1",
      offerId: "12345",
    }),
    Operation.changeTrust({ asset: USDC, limit: "0" }),
    merge(),
  ]),
  expectation()
);
reject(
  subentries,
  "data-entry-written",
  "The data entry operation writes a value instead of removing it.",
  build([
    Operation.manageData({ name: "note", value: "kept" }),
    Operation.manageSellOffer({
      selling: USDC,
      buying: Asset.native(),
      amount: "0",
      price: "1",
      offerId: "12345",
    }),
    Operation.changeTrust({ asset: USDC, limit: "0" }),
    merge(),
  ]),
  "data_entry_not_removal",
  "A data entry would be written, not removed."
);
reject(
  subentries,
  "offer-created",
  "The offer operation sells 10 USDC instead of cancelling.",
  build([
    Operation.manageData({ name: "note", value: null }),
    Operation.manageSellOffer({
      selling: USDC,
      buying: Asset.native(),
      amount: "10",
      price: "1",
      offerId: "12345",
    }),
    Operation.changeTrust({ asset: USDC, limit: "0" }),
    merge(),
  ]),
  "offer_not_cancellation",
  "An offer would be created, not cancelled."
);
reject(
  subentries,
  "operation-for-another-account",
  "The data entry removal names another account as its source.",
  build([
    Operation.manageData({ name: "note", value: null, source: OTHER_ACCOUNT }),
    Operation.manageSellOffer({
      selling: USDC,
      buying: Asset.native(),
      amount: "0",
      price: "1",
      offerId: "12345",
    }),
    Operation.changeTrust({ asset: USDC, limit: "0" }),
    merge(),
  ]),
  "operation_source_mismatch",
  "The transaction would act for an account other than the one being closed."
);

// --- A claimable balance claim --------------------------------------------------------------

const claim = accept(
  "claimable-balance-claim",
  "Adds the trustline the user chose to claim a balance into, then claims it. A claim round delivers nothing, so it carries no memo.",
  build([
    Operation.changeTrust({ asset: USDC }),
    Operation.claimClaimableBalance({ balanceId: BALANCE_ID }),
  ]),
  expectation({ claimTrustlineAssets: [USDC_KEY] })
);
reject(
  claim,
  "trustline-for-an-unchosen-asset",
  "Adds a trustline for EURT, which the user did not choose to claim.",
  build([
    Operation.changeTrust({ asset: EURT }),
    Operation.claimClaimableBalance({ balanceId: BALANCE_ID }),
  ]),
  "trustline_not_removal",
  "A trustline would be created or raised, not removed."
);

// --- A multisig close -----------------------------------------------------------------------

const multisigExpected = expectation({
  accountSigners: [signer(SOURCE), signer(COSIGNER)],
  accountThresholds: { low: 1, med: 2, high: 2 },
});
const multisigOps = (signerOp: xdr.Operation, thresholdOp: xdr.Operation) => [
  signerOp,
  thresholdOp,
  merge(),
];
const removeCosigner = Operation.setOptions({ signer: { ed25519PublicKey: COSIGNER, weight: 0 } });
const lowerThresholds = Operation.setOptions({
  lowThreshold: 0,
  medThreshold: 1,
  highThreshold: 1,
});

const multisig = accept(
  "multisig-close",
  "A 2-of-2 account: removes the co-signer, lowers the thresholds to 0/1/1, then merges.",
  build(multisigOps(removeCosigner, lowerThresholds)),
  multisigExpected
);
reject(
  multisig,
  "signer-added",
  "Adds a new signer with weight 1 instead of removing the co-signer.",
  build(
    multisigOps(
      Operation.setOptions({ signer: { ed25519PublicKey: NEW_SIGNER, weight: 1 } }),
      lowerThresholds
    )
  ),
  "signer_added",
  "A signer would be added or empowered."
);
reject(
  multisig,
  "signer-not-on-the-account",
  "Removes a signer the account read does not list.",
  build(
    multisigOps(
      Operation.setOptions({ signer: { ed25519PublicKey: NEW_SIGNER, weight: 0 } }),
      lowerThresholds
    )
  ),
  "signer_unknown",
  "This transaction touches a signer that wasn't on your account when we last read it. Re-run the analysis and try again."
);
reject(
  multisig,
  "threshold-raised",
  "Sets the high threshold to 2 instead of 1.",
  build(
    multisigOps(
      removeCosigner,
      Operation.setOptions({ lowThreshold: 0, medThreshold: 1, highThreshold: 2 })
    )
  ),
  "thresholds_raised",
  "Account thresholds would be raised."
);
reject(
  multisig,
  "master-weight-changed",
  "Sets the master key's weight alongside the thresholds.",
  build(
    multisigOps(
      removeCosigner,
      Operation.setOptions({ masterWeight: 2, lowThreshold: 0, medThreshold: 1, highThreshold: 1 })
    )
  ),
  "master_weight_changed",
  "The master key's weight would be changed."
);

const normalizationFirst = accept(
  "multisig-normalization-first",
  "The first transaction of a 2-of-2 close: removes the co-signer and lowers the thresholds to 0/1/1, with no merge.",
  build([removeCosigner, lowerThresholds]),
  multisigExpected
);
reject(
  normalizationFirst,
  "normalization-first-threshold-raised",
  "Sets the high threshold to 2 instead of 1 in the normalization transaction.",
  build([
    removeCosigner,
    Operation.setOptions({ lowThreshold: 0, medThreshold: 1, highThreshold: 2 }),
  ]),
  "thresholds_raised",
  "Account thresholds would be raised."
);
reject(
  normalizationFirst,
  "normalization-first-signer-added",
  "Adds a new signer with weight 1 in the normalization transaction.",
  build([
    removeCosigner,
    Operation.setOptions({ signer: { ed25519PublicKey: NEW_SIGNER, weight: 1 } }),
    lowerThresholds,
  ]),
  "signer_added",
  "A signer would be added or empowered."
);

// --- A memo the user confirmed --------------------------------------------------------------

const memoId = accept(
  "direct-merge-with-id-memo",
  "Merges to a wallet the user typed with the id memo they confirmed.",
  build([merge()], { memo: Memo.id("4411") }),
  expectation({ memo: "4411", memoType: "id" })
);
reject(
  memoId,
  "memo-type-changed",
  "Sends the same digits as a text memo.",
  build([merge()], { memo: Memo.text("4411") }),
  "memo_type_mismatch",
  "The transaction would send your memo as a text memo, not the id memo you confirmed."
);
reject(
  memoId,
  "memo-value-changed",
  "Sends id memo 4412.",
  build([merge()], { memo: Memo.id("4412") }),
  "memo_value_mismatch",
  "The transaction carries a memo you did not set."
);
reject(
  memoId,
  "memo-dropped",
  "Drops the memo.",
  build([merge()]),
  "memo_missing",
  "The transaction is missing the memo you set."
);

// --- An exchange close through the intermediary ---------------------------------------------

const forward = (over: { destination?: string; amount?: string; source?: string } = {}) =>
  Operation.payment({
    destination: over.destination ?? COINBASE,
    asset: Asset.native(),
    amount: over.amount ?? "100",
    source: over.source ?? INTERMEDIARY,
  });
const deposit = Memo.text("deposit-1");

const exchange = accept(
  "exchange-close-through-intermediary",
  "A close to a listed exchange: the merge pays an intermediary that forwards the whole balance to the exchange address the user typed, with their text memo.",
  build([merge(INTERMEDIARY), forward()], { memo: deposit }),
  expectation({ destination: COINBASE, memo: "deposit-1", memoType: "text" })
);
reject(
  exchange,
  "forward-short",
  "Forwards 99.98 XLM of a 100 XLM balance, below the 0.01 XLM tolerance.",
  build([merge(INTERMEDIARY), forward({ amount: "99.98" })], { memo: deposit }),
  "mediator_forward_short",
  "This transaction would hand your balance to an intermediary and pass on only part of it."
);
reject(
  exchange,
  "forward-elsewhere",
  "Forwards the balance to another address.",
  build([merge(INTERMEDIARY), forward({ destination: ATTACKER })], { memo: deposit }),
  "mediator_forward_destination_mismatch",
  `The transaction would pay funds to an unexpected address (${ATTACKER}).`
);
reject(
  exchange,
  "forward-sent-by-another-account",
  "The forward is sent by an account other than the one the merge paid.",
  build([merge(INTERMEDIARY), forward({ source: OTHER_ACCOUNT })], { memo: deposit }),
  "mediator_forward_source_mismatch",
  "The balance would be handed to one account and forwarded by another. Nothing guarantees the account receiving your funds is the one passing them on."
);
reject(
  exchange,
  "direct-merge-into-exchange",
  "Merges straight into the exchange, which cannot credit a merge.",
  build([merge(COINBASE)], { memo: deposit }),
  "merge_direct_refused",
  "This exchange cannot credit an account merge, so the balance has to reach it as a payment. This transaction would merge your account straight into it."
);

// --- A transfer the user chose --------------------------------------------------------------

const transferExpected = expectation({
  transfers: { [USDC_KEY]: { destination: FRIEND, amount: "25.0000000" } },
});
const transferOps = (destination: string, amount: string) => [
  Operation.payment({ destination, asset: USDC, amount }),
  Operation.changeTrust({ asset: USDC, limit: "0" }),
  merge(),
];

const transfer = accept(
  "transfer-to-chosen-account",
  "Sends the USDC balance to the account the user chose for it, removes the trustline, then merges.",
  build(transferOps(FRIEND, "25")),
  transferExpected
);
reject(
  transfer,
  "transfer-elsewhere",
  "Sends the USDC to another address.",
  build(transferOps(ATTACKER, "25")),
  "transfer_destination_mismatch",
  "The transaction would send USDC to an address you did not choose."
);
reject(
  transfer,
  "transfer-short",
  "Sends 24 USDC of the 25 the user approved.",
  build(transferOps(FRIEND, "24")),
  "transfer_amount_short",
  "The transaction would send less USDC than you approved."
);

// --- A served registry snapshot ------------------------------------------------------------
// The snapshot is the integrator's copy of `GET /v1/config/exchange-registry`. It is merged over
// the bundled registry and can only tighten; it never enables the intermediary.

/** The date the bundled exchange registry is valid until, and 2027-02-01T00:00:00Z, past it. */
const BUNDLED_UNTIL = "2027-01-08";
const PAST_BUNDLED_EXPIRY = 1_801_440_000;
const NEW_EXCHANGE = publicKey("newly listed exchange");

const listing = (
  address: string,
  rules: { requiresMediator: boolean; requiresMemo: boolean; memoType: "text" | "id" | "hash" }
) => ({ address, name: "Newly Listed", domain: "newly-listed.example", ...rules });
const snapshot = (
  entries: ServedRegistry["entries"],
  validUntil = BUNDLED_UNTIL
): ServedRegistry => ({ entries, lastVerified: "2026-10-25", validUntil });

const DIRECT_MERGE_REFUSED =
  "This exchange cannot credit an account merge, so the balance has to reach it as a payment. This transaction would merge your account straight into it.";

// A snapshot that tries to relax a bundled exchange, or to forget it, changes nothing.
const relaxingSnapshot = snapshot([
  {
    ...listing(COINBASE, { requiresMediator: false, requiresMemo: false, memoType: "text" }),
    name: "Coinbase",
    domain: "coinbase.com",
  },
]);
const underRelaxing = accept(
  "exchange-close-under-relaxing-snapshot",
  "The exchange close through the intermediary, with a served snapshot that lists the exchange as needing neither the intermediary nor a memo. A bundled exchange's rules cannot be relaxed, so the close stands as it is.",
  build([merge(INTERMEDIARY), forward()], { memo: deposit }),
  expectation({ destination: COINBASE, memo: "deposit-1", memoType: "text" }),
  { servedRegistry: relaxingSnapshot }
);
reject(
  underRelaxing,
  "direct-merge-into-exchange-under-relaxing-snapshot",
  "Merges straight into the exchange, which the snapshot claims can be merged into.",
  build([merge(COINBASE)], { memo: deposit }),
  "merge_direct_refused",
  DIRECT_MERGE_REFUSED
);
const underEmptied = accept(
  "exchange-close-under-emptied-snapshot",
  "The exchange close through the intermediary, with a served snapshot that lists no exchange at all. A bundled exchange cannot be removed.",
  build([merge(INTERMEDIARY), forward()], { memo: deposit }),
  expectation({ destination: COINBASE, memo: "deposit-1", memoType: "text" }),
  { servedRegistry: snapshot([]) }
);
reject(
  underEmptied,
  "direct-merge-into-exchange-under-emptied-snapshot",
  "Merges straight into the exchange the snapshot leaves out.",
  build([merge(COINBASE)], { memo: deposit }),
  "merge_direct_refused",
  DIRECT_MERGE_REFUSED
);

// A snapshot that lists the user's plain wallet as an exchange needing the intermediary: a direct
// merge is refused, and the hand-off is refused too, since served data never enables it.
const walletAsExchange = snapshot([
  listing(DESTINATION, { requiresMediator: true, requiresMemo: false, memoType: "text" }),
]);
rejectUnderSnapshot(
  minimal,
  "snapshot-lists-destination-as-needing-intermediary",
  "Passes a snapshot listing the destination as an exchange that needs the intermediary.",
  walletAsExchange,
  "merge_direct_refused",
  DIRECT_MERGE_REFUSED
);
rejectUnderSnapshot(
  minimal,
  "snapshot-enables-intermediary-for-destination",
  "Routes the merge through an intermediary that forwards the balance to the destination, with a snapshot listing the destination as needing the intermediary. A snapshot never enables the hand-off.",
  walletAsExchange,
  "merge_destination_mismatch",
  "The account would be merged to an address you did not choose.",
  build([merge(INTERMEDIARY), forward({ destination: DESTINATION })])
);

// Tightening is honored.
rejectUnderSnapshot(
  minimal,
  "snapshot-requires-memo-for-destination",
  "Passes a snapshot listing the destination as needing a deposit memo; the close carries none.",
  snapshot([
    listing(DESTINATION, { requiresMediator: false, requiresMemo: true, memoType: "text" }),
  ]),
  "memo_required",
  "This destination requires a deposit memo."
);
rejectUnderSnapshot(
  transfer,
  "snapshot-lists-transfer-destination-as-deposit-address",
  "Passes a snapshot listing the USDC transfer's destination as an exchange deposit address.",
  snapshot([listing(FRIEND, { requiresMediator: false, requiresMemo: true, memoType: "text" })]),
  "transfer_to_deposit_address",
  "The transaction would send USDC to a Newly Listed deposit address. A transfer in a close carries no deposit memo, so Newly Listed could not credit it. Go back to the plan and choose a wallet you control."
);
const listedBySnapshot = accept(
  "close-to-exchange-listed-by-snapshot",
  "A direct merge to an exchange only the served snapshot lists, which accepts a merge but needs an id memo. The user confirmed an id memo, the snapshot's type.",
  build([merge(NEW_EXCHANGE)], { memo: Memo.id("4411") }),
  expectation({ destination: NEW_EXCHANGE, memo: "4411", memoType: "id" }),
  {
    servedRegistry: snapshot([
      listing(NEW_EXCHANGE, { requiresMediator: false, requiresMemo: true, memoType: "id" }),
    ]),
  }
);
reject(
  listedBySnapshot,
  "memo-type-other-than-snapshot",
  "Sends the memo as text instead of the id the user confirmed and the snapshot lists.",
  build([merge(NEW_EXCHANGE)], { memo: Memo.text("4411") }),
  "memo_type_mismatch",
  "The transaction would send your memo as a text memo, not the id memo you confirmed."
);
rejectUnderSnapshot(
  listedBySnapshot,
  "snapshot-memo-type-other-than-confirmed",
  "Passes a snapshot listing the exchange with a text memo, though the user confirmed an id memo. A served type never replaces the confirmed one.",
  snapshot([
    listing(NEW_EXCHANGE, { requiresMediator: false, requiresMemo: true, memoType: "text" }),
  ]),
  "registry_memo_type_unconfirmed",
  "The served exchange registry lists Newly Listed with a text memo, not the id memo you confirmed."
);

// A snapshot never changes the memo type of a bundled exchange: the close is refused instead.
const numericTextMemo = Memo.text("4411");
const exchangeNumericTextMemo = accept(
  "exchange-close-with-numeric-text-memo",
  "The exchange close through the intermediary, with a text memo of digits, the type the bundled registry gives the exchange.",
  build([merge(INTERMEDIARY), forward()], { memo: numericTextMemo }),
  expectation({ destination: COINBASE, memo: "4411", memoType: "text" })
);
rejectUnderSnapshot(
  exchangeNumericTextMemo,
  "snapshot-changes-exchange-memo-type",
  "Passes a snapshot listing the exchange with an id memo and sends the memo as an id memo. A snapshot cannot change a bundled exchange's memo type.",
  snapshot([
    {
      ...listing(COINBASE, { requiresMediator: true, requiresMemo: true, memoType: "id" }),
      name: "Coinbase",
    },
  ]),
  "registry_memo_type_conflict",
  "The served exchange registry gives Coinbase a different memo type than the bundled one, so the memo this close needs cannot be checked.",
  build([merge(INTERMEDIARY), forward()], { memo: Memo.id("4411") })
);
rejectUnderSnapshot(
  exchangeNumericTextMemo,
  "snapshot-disputes-exchange-memo-type",
  "Passes a snapshot listing the exchange with an id memo; the close still sends the bundled text memo. A disputed memo type refuses the close whatever memo it carries.",
  snapshot([
    {
      ...listing(COINBASE, { requiresMediator: true, requiresMemo: true, memoType: "id" }),
      name: "Coinbase",
    },
  ]),
  "registry_memo_type_conflict",
  "The served exchange registry gives Coinbase a different memo type than the bundled one, so the memo this close needs cannot be checked."
);

// Validity only moves later, within the cap, never earlier.
accept(
  "exchange-close-under-snapshot-with-earlier-expiry",
  "The exchange close through the intermediary, with a snapshot valid only until 2026-10-15, before the clock. A snapshot cannot move the bundled expiry earlier, so the bundled date stands.",
  build([merge(INTERMEDIARY), forward()], { memo: deposit }),
  expectation({ destination: COINBASE, memo: "deposit-1", memoType: "text" }),
  { servedRegistry: snapshot([], "2026-10-15") }
);
const extended = accept(
  "exchange-close-past-bundled-expiry-extended-by-snapshot",
  "The exchange close through the intermediary on 2027-02-01, past the bundled registry's validity, with a snapshot valid until 2027-03-01: within 120 days of the bundled date, so it extends it.",
  build([merge(INTERMEDIARY), forward()], { memo: deposit, maxTime: PAST_BUNDLED_EXPIRY + 300 }),
  expectation({ destination: COINBASE, memo: "deposit-1", memoType: "text" }),
  { nowSeconds: PAST_BUNDLED_EXPIRY, servedRegistry: snapshot([], "2027-03-01") }
);
rejectUnderSnapshot(
  extended,
  "snapshot-extends-expiry-past-cap",
  "Passes a snapshot valid until 2027-06-01, more than 120 days past the bundled date, so the bundled date stands and has passed.",
  snapshot([], "2027-06-01"),
  "registry_expired",
  "The exchange deposit rules have expired and have not been re-verified, so this close cannot be checked. Refresh the page; if it persists, the registry needs updating."
);

// A snapshot that is not a registry is refused, not ignored.
rejectUnderSnapshot(
  minimal,
  "snapshot-not-a-registry",
  "Passes a snapshot whose entries are not a list.",
  {
    entries: "none",
    lastVerified: "2026-10-25",
    validUntil: BUNDLED_UNTIL,
  } as unknown as ServedRegistry,
  "registry_snapshot_invalid",
  "The exchange registry passed to the verifier is not a registry (it needs an entries list, lastVerified and validUntil), so this close cannot be checked against it."
);

// --- A classic conversion -------------------------------------------------------------------

const conversionOps = (destination: string, destMin: string) => [
  Operation.pathPaymentStrictSend({
    sendAsset: USDC,
    sendAmount: "25",
    destination,
    destAsset: Asset.native(),
    destMin,
    path: [],
  }),
  Operation.changeTrust({ asset: USDC, limit: "0" }),
  merge(),
];

const conversion = accept(
  "classic-conversion-to-xlm",
  "Converts the USDC balance to XLM into the account with at least the 9.5 XLM the user was shown, then merges.",
  build(conversionOps(SOURCE, "9.5")),
  expectation({ classicConversions: { [USDC_KEY]: { minAmountOut: "95000000" } } })
);
reject(
  conversion,
  "conversion-pays-out",
  "The conversion pays another address instead of the account.",
  build(conversionOps(ATTACKER, "9.5")),
  "conversion_recipient_mismatch",
  "A conversion would send funds out of your account."
);
reject(
  conversion,
  "conversion-below-floor",
  "Lowers the conversion's minimum to 9.4 XLM.",
  build(conversionOps(SOURCE, "9.4")),
  "conversion_min_out_below_floor",
  "A conversion of USDC would accept less XLM than the minimum you were shown."
);

// --- Real DeFi exits, built by the API's adapters on testnet --------------------------------

for (const fixture of REAL_EXIT_ENVELOPES) {
  const { account } = fixture;
  const slug = fixture.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const real = accept(
    `real-exit-${slug}`,
    `The real ${fixture.name} envelope the API's adapter built on testnet, verified at the moment it was built.`,
    fixture.xdr,
    {
      source: account.address,
      destination: DESTINATION,
      nativeBalance: account.nativeBalanceLumens,
      memo: null,
      memoType: null,
      claimTrustlineAssets: [],
      accountSigners: account.signers,
      accountThresholds: account.thresholds,
      transfers: {},
      tokenTransfers: {},
      classicConversions: {},
      tokenConversions: {},
      ...exitExpectations(account, "testnet"),
    },
    {
      nowSeconds: Number(fixture.expected.maxTime) - 300,
      provenance: {
        ...fixture.provenance,
        fixture: "apps/web/tests/unit/fixtures/real-exit-envelopes.ts",
      },
    }
  );
  const envelope = xdr.TransactionEnvelope.fromXdr(fixture.xdr, "base64");
  if (envelope.type !== "envelopeTypeTx") throw new Error(`${fixture.name} is not a v1 envelope`);
  (envelope.v1.tx as { fee: number }).fee = 10_000_001;
  reject(
    real,
    `real-exit-${slug}-fee-above-cap`,
    "Raises the envelope's fee to 10,000,001 stroops, one above the 1 XLM cap on a DeFi exit.",
    envelope.toXdr("base64"),
    "fee_above_cap",
    "A DeFi exit would pay a network fee far above what any exit needs."
  );
}

export function buildVectorFile(): VectorFile {
  return {
    schema: 1,
    name: "close-v1",
    description:
      "Conformance vectors for verifyCloseTransaction. Set the clock to nowSeconds, call the verifier with input, and expect it to return (accept) or to throw a VerificationError with exactly error.code and error.message (reject). The code is the stable reason to branch on; the message is the current English wording. Each reject is one named mutation of the accept named in base: its transaction, its served registry snapshot, or both. Pass input.servedRegistry to the verifier when it is present. Every key is public.",
    generator: "packages/verify/scripts/generate-vectors.ts",
    vectors: [...accepts, ...rejects],
  };
}

export const serialize = (file: VectorFile): string => `${JSON.stringify(file, null, 2)}\n`;

if (import.meta.main) {
  const fresh = serialize(buildVectorFile());
  if (process.argv.includes("--check")) {
    let committed: string;
    try {
      committed = readFileSync(VECTORS_PATH, "utf8");
    } catch {
      committed = "";
    }
    if (committed !== fresh) {
      console.error(
        "vectors/close-v1.json is out of date. Run `bun run --filter '@lumenwipe/verify' vectors` and commit the result."
      );
      process.exit(1);
    }
    console.log("vectors/close-v1.json is up to date.");
  } else {
    writeFileSync(VECTORS_PATH, fresh);
    console.log(`Wrote ${VECTORS_PATH}.`);
  }
}
