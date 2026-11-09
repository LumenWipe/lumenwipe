import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import {
  Account,
  Asset,
  Keypair,
  Memo,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { VerificationError } from "@lumenwipe/verify";
import type { CloseTransaction } from "@lumenwipe/sdk";
import { selectionForMode } from "@/lib/mess-plan";
import type { ScenarioSelection } from "@/lib/scenarios";
import {
  expectationFromSession,
  maxOperations,
  PLAYGROUND_CLOSE_OPERATION_TYPES,
  PlaygroundVerificationError,
  verifyDemolishTransaction,
  type PlaygroundCloseExpectation,
} from "@/lib/verify";
import recipeFixture from "../fixtures/api-recipe-close.json";

// The playground verifies with `@lumenwipe/verify`, the web app's own trust anchor, held to the
// session record. These tests pin what each rule means for a playground close; the rules
// themselves are tested where they live (apps/web/tests/unit/verify*.test.ts and the conformance
// vectors in packages/verify).

const NOW = 1_800_000_000;
const PASSPHRASE = Networks.TESTNET;

beforeEach(() => setSystemTime(new Date(NOW * 1000)));
afterEach(() => setSystemTime());

const demo = Keypair.random().publicKey();
const sink = Keypair.random().publicKey();
const lwdemoIssuer = Keypair.random().publicKey();
const airdropIssuer = Keypair.random().publicKey();
const rugIssuer = Keypair.random().publicKey();
const forgotten = Keypair.random().publicKey();
const LWDEMO = new Asset("LWDEMO", lwdemoIssuer);
const RUGPULL = new Asset("RUGPULL", rugIssuer);

const SELECTION: ScenarioSelection = {
  scenarios: [
    { id: "lwdemo-holding", params: {} },
    { id: "junk-airdrops", params: { tokens: 2 } },
    { id: "data-entries", params: { count: 2 } },
    { id: "stale-offers", params: { count: 2 } },
    { id: "forgotten-signer", params: {} },
  ],
};

const ISSUERS = [
  { assetCode: "AIRDROP1", publicKey: airdropIssuer, encSecret: "enc" },
  { assetCode: "RUGPULL", publicKey: rugIssuer, encSecret: "enc" },
];

function expectation(
  selection = SELECTION,
  ephemeralIssuers = ISSUERS
): PlaygroundCloseExpectation {
  return expectationFromSession(
    { demoPublic: demo, ephemeralIssuers, recordedSigners: [forgotten], selection },
    sink,
    lwdemoIssuer
  );
}

interface TxOptions {
  source?: string;
  fee?: number;
  maxTime?: number;
  memo?: string;
}

/** A transaction of `ops`, followed by the merge to the sink unless `merge` is false. */
function envelope(ops: xdr.Operation[], opts: TxOptions = {}, merge = true): string {
  const all = merge ? [...ops, Operation.accountMerge({ destination: sink })] : ops;
  const builder = new TransactionBuilder(new Account(opts.source ?? demo, "1"), {
    fee: String(opts.fee ?? 100),
    networkPassphrase: PASSPHRASE,
    ...(opts.memo === undefined ? {} : { memo: Memo.text(opts.memo) }),
  }).setTimebounds(0, opts.maxTime ?? NOW + 300);
  all.forEach((op) => builder.addOperation(op));
  return builder.build().toEnvelope().toXdr("base64");
}

function closeTx(xdrBase64: string): CloseTransaction {
  return {
    id: "t1",
    order: 0,
    dependsOn: [],
    xdr: xdrBase64,
    networkPassphrase: PASSPHRASE,
    sourceSequence: "1",
    validUntilLedger: 100,
    covers: [],
    intent: {
      summary: "test fixture",
      source: demo,
      fee: "100",
      memo: null,
      memoType: null,
      guarantees: { mergeDestination: null, paymentsOnlyTo: [], minXlmFromConversions: null },
      operations: [],
    },
  };
}

/** Rewrites an envelope to carry no operations, which the SDK's builder never produces. */
function withoutOperations(envelopeXdr: string): string {
  const envelope = xdr.TransactionEnvelope.fromXdr(envelopeXdr, "base64");
  if (envelope.type !== "envelopeTypeTx") throw new Error("expected a v1 envelope");
  const { tx } = envelope.v1;
  const empty = new xdr.Transaction({
    sourceAccount: tx.sourceAccount,
    fee: tx.fee,
    seqNum: tx.seqNum,
    cond: tx.cond,
    memo: tx.memo,
    operations: [],
    ext: tx.ext,
  });
  return xdr.TransactionEnvelope.envelopeTypeTx(
    new xdr.TransactionV1Envelope({ tx: empty, signatures: [] })
  ).toXdr("base64");
}

/** The refusal code, or "accepted". */
function outcome(xdrBase64: string, expected = expectation()): string {
  try {
    verifyDemolishTransaction(closeTx(xdrBase64), expected);
    return "accepted";
  } catch (err) {
    if (err instanceof VerificationError) return err.code;
    if (err instanceof PlaygroundVerificationError) return err.message;
    throw err;
  }
}

const returnToIssuer = (asset: Asset) =>
  Operation.payment({ destination: asset.getIssuer() ?? "", asset, amount: "5" });

type Recipe = (typeof recipeFixture.recipes)[number];

/** The registry selection each fixture recipe models (apps/api/tests/unit/playground-recipe.test.ts). */
const RECIPE_SELECTIONS: Record<string, ScenarioSelection> = {
  light: selectionForMode("light"),
  full: selectionForMode("full"),
  "custom-max": selectionForMode("custom", {
    trustlineCount: 5,
    offerCount: 5,
    dataEntryCount: 5,
    addSigner: true,
  }),
};

function recipeExpectation(recipe: Recipe, recordedSigners: string[]): PlaygroundCloseExpectation {
  const { session } = recipe;
  const selection = RECIPE_SELECTIONS[recipe.name];
  if (!selection) throw new Error(`no selection for recipe ${recipe.name}`);
  return expectationFromSession(
    {
      demoPublic: session.demoPublic,
      ephemeralIssuers: session.ephemeralIssuers.map((e) => ({ ...e, encSecret: "enc" })),
      recordedSigners,
      selection,
    },
    session.sinkPublic,
    session.lwdemoIssuer
  );
}

describe("the API's real transactions for today's recipes", () => {
  // Built by apps/api's buildCloseTransactions (apps/api/tests/unit/playground-recipe.test.ts),
  // which fails when the builder's output stops matching this fixture.
  test("every transaction verifies against its session", () => {
    setSystemTime(new Date(recipeFixture.builtAtSeconds * 1000));
    for (const recipe of recipeFixture.recipes) {
      const expected = recipeExpectation(recipe, recipe.session.recordedSigners);
      expect(recipe.transactions.length).toBeGreaterThan(0);
      for (const tx of recipe.transactions) {
        expect({ recipe: recipe.name, outcome: outcome(tx, expected) }).toEqual({
          recipe: recipe.name,
          outcome: "accepted",
        });
      }
    }
  });

  test("each recipe's session counts are what its registry selection plans", () => {
    for (const recipe of recipeFixture.recipes) {
      const expected = recipeExpectation(recipe, recipe.session.recordedSigners);
      expect({
        recipe: recipe.name,
        offers: expected.offerCount,
        data: expected.dataEntryCount,
        assets: expected.assets.length,
      }).toEqual({
        recipe: recipe.name,
        offers: recipe.session.offerCount,
        data: recipe.session.dataEntryCount,
        assets: recipe.session.ephemeralIssuers.length + 1,
      });
    }
  });

  test("covers the light, full and largest custom recipes", () => {
    expect(recipeFixture.recipes.map((r) => r.name)).toEqual(["light", "full", "custom-max"]);
  });

  test("the full recipe is refused without the signer the session recorded", () => {
    setSystemTime(new Date(recipeFixture.builtAtSeconds * 1000));
    const full = recipeFixture.recipes.find((r) => r.name === "full")!;
    expect(outcome(full.transactions[0]!, recipeExpectation(full, []))).toBe("signer_unknown");
  });
});

describe("expectationFromSession", () => {
  test("takes the planned assets from the persistent issuer and the session's ephemeral issuers", () => {
    expect(expectation().assets).toEqual([
      { code: "LWDEMO", issuer: lwdemoIssuer },
      { code: "AIRDROP1", issuer: airdropIssuer },
      { code: "RUGPULL", issuer: rugIssuer },
    ]);
    expect([expectation().offerCount, expectation().dataEntryCount]).toEqual([2, 2]);
  });

  test("a session that did not select the demo token cannot return it", () => {
    const noLwdemo: ScenarioSelection = {
      scenarios: [{ id: "junk-airdrops", params: { tokens: 2 } }],
    };
    const expected = expectation(noLwdemo);
    expect(expected.assets.map((a) => a.code)).toEqual(["AIRDROP1", "RUGPULL"]);
    expect(outcome(envelope([returnToIssuer(LWDEMO)]), expected)).toBe("transfer_not_chosen");
    expect(outcome(envelope([returnToIssuer(RUGPULL)]), expected)).toBe("accepted");
  });

  test("a planned asset without the session's own issuer is refused", () => {
    expect(() => expectation(SELECTION, ISSUERS.slice(0, 1))).toThrow("session_issuer_missing");
  });

  test("copies the recorded signers rather than sharing the session's array", () => {
    const recordedSigners = [forgotten];
    const expected = expectationFromSession(
      {
        demoPublic: demo,
        ephemeralIssuers: [],
        recordedSigners,
        selection: selectionForMode("light"),
      },
      sink,
      lwdemoIssuer
    );
    recordedSigners.push(Keypair.random().publicKey());
    expect(expected.recordedSigners).toEqual([forgotten]);
  });
});

describe("removal only", () => {
  test("a trustline removal is accepted; a trustline with a limit is refused", () => {
    const trust = (limit: string) => Operation.changeTrust({ asset: LWDEMO, limit });
    expect(outcome(envelope([trust("0")]))).toBe("accepted");
    expect(outcome(envelope([trust("1")]))).toBe("trustline_not_removal");
  });

  test("a data entry removal is accepted; a data entry write is refused", () => {
    const data = (value: string | null) => Operation.manageData({ name: "promo_code", value });
    expect(outcome(envelope([data(null)]))).toBe("accepted");
    expect(outcome(envelope([data("x")]))).toBe("data_entry_not_removal");
  });

  test("an offer cancellation is accepted; an offer with an amount is refused", () => {
    const offer = (amount: string) =>
      Operation.manageSellOffer({
        selling: Asset.native(),
        buying: LWDEMO,
        amount,
        price: "2",
        offerId: "1",
      });
    expect(outcome(envelope([offer("0")]))).toBe("accepted");
    expect(outcome(envelope([offer("5")]))).toBe("offer_not_cancellation");
  });
});

describe("setOptions", () => {
  const signer = (key: string, weight: number) =>
    Operation.setOptions({ signer: { ed25519PublicKey: key, weight } });

  test("removing the signer the session recorded is accepted", () => {
    expect(outcome(envelope([signer(forgotten, 0)]))).toBe("accepted");
  });

  test("removing a signer the session did not record is refused", () => {
    expect(outcome(envelope([signer(Keypair.random().publicKey(), 0)]))).toBe("signer_unknown");
  });

  test("adding or empowering a signer is refused", () => {
    expect(outcome(envelope([signer(forgotten, 1)]))).toBe("signer_added");
  });

  test("the master key's weight is kept", () => {
    expect(outcome(envelope([Operation.setOptions({ masterWeight: 0 })]))).toBe(
      "master_weight_changed"
    );
  });

  test("thresholds may be reset to 0/1/1 but not raised", () => {
    const reset = Operation.setOptions({ lowThreshold: 0, medThreshold: 1, highThreshold: 1 });
    expect(outcome(envelope([reset]))).toBe("accepted");
    expect(outcome(envelope([Operation.setOptions({ highThreshold: 2 })]))).toBe(
      "thresholds_raised"
    );
  });

  test("flags, the home domain and the inflation destination are not changed", () => {
    for (const op of [
      Operation.setOptions({ setFlags: 1 }),
      Operation.setOptions({ clearFlags: 1 }),
      Operation.setOptions({ homeDomain: "example.com" }),
      Operation.setOptions({ inflationDest: sink }),
    ]) {
      expect(outcome(envelope([op]))).toBe("account_settings_changed");
    }
  });
});

describe("the merge", () => {
  test("one merge to the sink, as the final operation, is accepted", () => {
    expect(outcome(envelope([]))).toBe("accepted");
  });

  test("a merge to any other destination is refused", () => {
    const op = Operation.accountMerge({ destination: Keypair.random().publicKey() });
    expect(outcome(envelope([op], {}, false))).toBe("merge_destination_mismatch");
  });

  test("a transaction without a merge is refused", () => {
    const op = Operation.manageData({ name: "promo_code", value: null });
    expect(outcome(envelope([op], {}, false))).toBe("merge_not_final");
  });

  test("a transaction with no operations is refused", () => {
    expect(outcome(withoutOperations(envelope([], { fee: 0 })))).toBe("merge_not_final");
  });

  test("a merge that is not the final operation is refused", () => {
    const ops = [
      Operation.accountMerge({ destination: sink }),
      Operation.manageData({ name: "promo_code", value: null }),
    ];
    expect(outcome(envelope(ops, {}, false))).toBe("merge_not_final");
  });

  test("a second merge is refused", () => {
    expect(outcome(envelope([Operation.accountMerge({ destination: sink })]))).toBe(
      "merge_multiple"
    );
  });
});

describe("memo", () => {
  test("no memo is accepted; any memo is refused, since the session expects none", () => {
    expect(outcome(envelope([]))).toBe("accepted");
    expect(outcome(envelope([], { memo: "hi" }))).toBe("memo_unexpected");
  });
});

describe("ceilings", () => {
  test("the operation count is capped by what the session's entries can explain", () => {
    // 3 assets x 2 + 2 offers + 2 data entries + 1 signer + threshold reset + merge.
    expect(maxOperations(expectation())).toBe(13);
    const removals = (n: number) =>
      Array.from({ length: n }, () => Operation.manageData({ name: "promo_code", value: null }));
    expect(outcome(envelope(removals(12)))).toBe("accepted");
    expect(outcome(envelope(removals(13)))).toBe("too_many_operations");
  });

  test("the fee is capped at ten times the base fee per operation", () => {
    expect(outcome(envelope([], { fee: 1000 }))).toBe("accepted");
    expect(outcome(envelope([], { fee: 1001 }))).toBe("fee_above_cap");
  });

  test("the transaction expires within fifteen minutes", () => {
    expect(outcome(envelope([], { maxTime: NOW + 900 }))).toBe("accepted");
    expect(outcome(envelope([], { maxTime: NOW + 901 }))).toBe("expiry_too_far");
    expect(outcome(envelope([], { maxTime: 0 }))).toBe("expiry_missing");
  });
});

describe("payments", () => {
  test("returning a session asset to its own issuer is accepted", () => {
    expect(outcome(envelope([returnToIssuer(LWDEMO), returnToIssuer(RUGPULL)]))).toBe("accepted");
  });

  test("an asset from an issuer outside the session is refused, even paid to its issuer", () => {
    const stranger = new Asset("RUGPULL", Keypair.random().publicKey());
    expect(outcome(envelope([returnToIssuer(stranger)]))).toBe("transfer_not_chosen");
  });

  test("a session asset paid anywhere but its issuer is refused", () => {
    const op = Operation.payment({ destination: sink, asset: LWDEMO, amount: "5" });
    expect(outcome(envelope([op]))).toBe("transfer_destination_mismatch");
  });

  test("a native payment is refused, including one to the sink", () => {
    const op = Operation.payment({ destination: sink, asset: Asset.native(), amount: "5" });
    expect(outcome(envelope([op]))).toBe("transfer_not_chosen");
  });
});

describe("what a playground close never contains", () => {
  test("a conversion is refused: the playground never chooses one", () => {
    const op = Operation.pathPaymentStrictSend({
      sendAsset: LWDEMO,
      sendAmount: "5",
      destination: demo,
      destAsset: Asset.native(),
      destMin: "1",
    });
    expect(outcome(envelope([op]))).toBe("conversion_asset_not_chosen");
  });

  test("an operation the shared anchor does not recognize is refused", () => {
    expect(outcome(envelope([Operation.bumpSequence({ bumpTo: "10" })]))).toBe("operation_unknown");
    const create = Operation.createAccount({ destination: sink, startingBalance: "1" });
    expect(outcome(envelope([create]))).toBe("operation_unknown");
  });

  test("a Soroban call is refused: the demo account holds no DeFi position", () => {
    const op = Operation.invokeContractFunction({
      contract: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      function: "withdraw",
      args: [],
    });
    expect(outcome(envelope([op], {}, false))).toBe("exit_contract_not_position");
  });

  test("an operation sent by another account is refused", () => {
    const op = Operation.manageData({ name: "promo_code", value: null, source: sink });
    expect(outcome(envelope([op]))).toBe("operation_source_mismatch");
  });

  test("a fee bump is refused, whoever pays its fee", () => {
    const inner = TransactionBuilder.fromXDR(envelope([]), PASSPHRASE) as Transaction;
    for (const feeSource of [sink, demo]) {
      const bump = TransactionBuilder.buildFeeBumpTransaction(feeSource, "200", inner, PASSPHRASE);
      expect({ feeSource, outcome: outcome(bump.toEnvelope().toXdr("base64")) }).toEqual({
        feeSource,
        outcome: "fee_bump_not_allowed",
      });
    }
  });

  test("a fee bump paid by the demo account itself is refused", () => {
    const inner = TransactionBuilder.fromXDR(envelope([]), PASSPHRASE) as Transaction;
    const bump = TransactionBuilder.buildFeeBumpTransaction(demo, "200", inner, PASSPHRASE);
    expect(outcome(bump.toEnvelope().toXdr("base64"))).toBe("fee_bump_not_allowed");
  });

  test("a transaction for another account is refused", () => {
    expect(outcome(envelope([], { source: sink }))).toBe("transaction_source_mismatch");
  });

  test("a sponsorship revocation, as the real builder emits it, is accepted", () => {
    const op = Operation.revokeDataSponsorship({ account: demo, name: "promo_code" });
    expect(outcome(envelope([op]))).toBe("accepted");
  });
});

describe("the playground's close operation types", () => {
  test("one close holding every listed type is accepted, and lists exactly those types", () => {
    const ops = [
      Operation.revokeAccountSponsorship({ account: demo }),
      Operation.revokeTrustlineSponsorship({ account: demo, asset: LWDEMO }),
      Operation.revokeOfferSponsorship({ seller: demo, offerId: "1" }),
      Operation.revokeDataSponsorship({ account: demo, name: "promo_code" }),
      Operation.revokeSignerSponsorship({ account: demo, signer: { ed25519PublicKey: forgotten } }),
      Operation.manageData({ name: "promo_code", value: null }),
      Operation.manageSellOffer({
        selling: Asset.native(),
        buying: LWDEMO,
        amount: "0",
        price: "2",
        offerId: "1",
      }),
      returnToIssuer(LWDEMO),
      Operation.changeTrust({ asset: LWDEMO, limit: "0" }),
      Operation.setOptions({ signer: { ed25519PublicKey: forgotten, weight: 0 } }),
    ];
    const xdrBase64 = envelope(ops);
    expect(outcome(xdrBase64)).toBe("accepted");
    const parsed = TransactionBuilder.fromXDR(xdrBase64, PASSPHRASE);
    if (!(parsed instanceof Transaction)) throw new Error("expected a transaction");
    expect(new Set(parsed.operations.map((op) => op.type))).toEqual(
      new Set(PLAYGROUND_CLOSE_OPERATION_TYPES)
    );
  });

  test("a type the shared anchor allows but no scenario creates is refused", () => {
    const claim = Operation.claimClaimableBalance({ balanceId: `00000000${"a".repeat(64)}` });
    expect(outcome(envelope([claim]))).toBe("operation_not_allowed");
  });
});
