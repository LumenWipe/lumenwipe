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
  type xdr,
} from "@stellar/stellar-sdk";
import { VerificationError } from "@lumenwipe/verify";
import type { CloseTransaction } from "@lumenwipe/sdk";
import {
  expectationFromSession,
  maxOperations,
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
const rugIssuer = Keypair.random().publicKey();
const forgotten = Keypair.random().publicKey();
const LWDEMO = new Asset("LWDEMO", lwdemoIssuer);
const RUGPULL = new Asset("RUGPULL", rugIssuer);

function expectation(): PlaygroundCloseExpectation {
  return expectationFromSession(
    {
      demoPublic: demo,
      ephemeralIssuers: [{ assetCode: "RUGPULL", publicKey: rugIssuer, encSecret: "enc" }],
      recordedSigners: [forgotten],
      offerCount: 2,
      dataEntryCount: 2,
    },
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

function recipeExpectation(recipe: Recipe, recordedSigners: string[]): PlaygroundCloseExpectation {
  const { session } = recipe;
  return expectationFromSession(
    {
      demoPublic: session.demoPublic,
      ephemeralIssuers: session.ephemeralIssuers.map((e) => ({ ...e, encSecret: "enc" })),
      recordedSigners,
      offerCount: session.offerCount,
      dataEntryCount: session.dataEntryCount,
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
  test("takes the assets from the persistent issuer and the session's ephemeral issuers", () => {
    expect(expectation().assets).toEqual([
      { code: "LWDEMO", issuer: lwdemoIssuer },
      { code: "RUGPULL", issuer: rugIssuer },
    ]);
  });

  test("copies the recorded signers rather than sharing the session's array", () => {
    const recordedSigners = [forgotten];
    const expected = expectationFromSession(
      { demoPublic: demo, ephemeralIssuers: [], recordedSigners, offerCount: 0, dataEntryCount: 0 },
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
    // 2 assets x 2 + 2 offers + 2 data entries + 1 signer + threshold reset + merge.
    expect(maxOperations(expectation())).toBe(11);
    const removals = (n: number) =>
      Array.from({ length: n }, () => Operation.manageData({ name: "promo_code", value: null }));
    expect(outcome(envelope(removals(10)))).toBe("accepted");
    expect(outcome(envelope(removals(11)))).toBe("too_many_operations");
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

  test("a fee bump is refused", () => {
    const inner = TransactionBuilder.fromXDR(envelope([]), PASSPHRASE) as Transaction;
    const bump = TransactionBuilder.buildFeeBumpTransaction(sink, "200", inner, PASSPHRASE);
    expect(outcome(bump.toEnvelope().toXdr("base64"))).toBe("transaction_source_mismatch");
  });

  test("a transaction for another account is refused", () => {
    expect(outcome(envelope([], { source: sink }))).toBe("transaction_source_mismatch");
  });

  test("a sponsorship revocation, as the real builder emits it, is accepted", () => {
    const op = Operation.revokeDataSponsorship({ account: demo, name: "promo_code" });
    expect(outcome(envelope([op]))).toBe("accepted");
  });
});
