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
import { parseSelection, type ScenarioSelection } from "@/lib/scenarios";
import {
  amountToStroops,
  expectationFromSession,
  maxOperations,
  PLAYGROUND_CLOSE_OPERATION_TYPES,
  PlaygroundVerificationError,
  verifyDemolishTransaction,
  type PlaygroundCloseExpectation,
} from "@/lib/verify";
import recipeFixture from "../fixtures/api-recipe-close.json";
import dispositionsFixture from "../fixtures/api-recipe-dispositions.json";
import claimsFixture from "../fixtures/api-recipe-claims.json";

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
const LWCOIN = new Asset("LWCOIN", lwdemoIssuer);
const LWGEM = new Asset("LWGEM", lwdemoIssuer);
const bonusIssuer = Keypair.random().publicKey();
const giftIssuer = Keypair.random().publicKey();
const perkIssuer = Keypair.random().publicKey();
const beneficiary = Keypair.random().publicKey();
const BONUS = new Asset("BONUS", bonusIssuer);
const GIFT = new Asset("GIFT", giftIssuer);
const PERK = new Asset("PERK", perkIssuer);
const balanceId = (fill: string): string => `00000000${fill.repeat(64)}`;
const BONUS_ID = balanceId("b");
const GIFT_ID = balanceId("c");
const LATE_ID = balanceId("d");

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
    {
      demoPublic: demo,
      ephemeralIssuers,
      recordedSigners: [forgotten],
      selection,
      transferRecipient: null,
      helperAccounts: [],
      claimableBalances: [],
    },
    sink,
    lwdemoIssuer
  );
}

/** Every claimable-balance kind and the demo sponsoring a beneficiary, beside the default selection. */
const CLAIMS_SELECTION: ScenarioSelection = {
  scenarios: [
    ...SELECTION.scenarios,
    { id: "claimable-balances", params: { add_trustline: 1, time_gated: 1, demo_sponsored: 0 } },
    { id: "sponsored-reserves", params: { variant: 1 } },
  ],
};

function claimsExpectation(selection = CLAIMS_SELECTION): PlaygroundCloseExpectation {
  return expectationFromSession(
    {
      demoPublic: demo,
      ephemeralIssuers: [
        ...ISSUERS,
        { assetCode: "BONUS", publicKey: bonusIssuer, encSecret: "enc" },
        { assetCode: "GIFT", publicKey: giftIssuer, encSecret: "enc" },
        { assetCode: "PERK", publicKey: perkIssuer, encSecret: "enc" },
      ],
      recordedSigners: [forgotten],
      selection,
      transferRecipient: null,
      helperAccounts: [{ role: "beneficiary", publicKey: beneficiary, encSecret: "enc" }],
      claimableBalances: [
        { id: BONUS_ID, asset: `BONUS:${bonusIssuer}`, intent: "claim" },
        { id: GIFT_ID, asset: `GIFT:${giftIssuer}`, intent: "add_trustline_then_claim" },
        { id: LATE_ID, asset: `BONUS:${bonusIssuer}`, intent: "forfeit" },
      ],
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
      transferRecipient: null,
      helperAccounts: [],
      claimableBalances: [],
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

  // The fixture is unchanged by the dispositions scenario: a session without it still expects only
  // returns to the issuer, with no transfer and no conversion, and every transaction still verifies.
  test("a session without the dispositions scenario expects no transfer and no conversion", () => {
    for (const recipe of recipeFixture.recipes) {
      const expected = recipeExpectation(recipe, recipe.session.recordedSigners);
      expect({
        recipe: recipe.name,
        transfers: expected.transfers,
        conversions: expected.conversions,
      }).toEqual({
        recipe: recipe.name,
        transfers: [],
        conversions: [],
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
        transferRecipient: null,
        helperAccounts: [],
        claimableBalances: [],
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
  test("a conversion is refused unless the session chose one", () => {
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

  test("a sponsorship revocation the session did not record is refused", () => {
    const op = Operation.revokeDataSponsorship({ account: demo, name: "promo_code" });
    expect(outcome(envelope([op]))).toBe("revoke_not_recorded");
  });
});

describe("the playground's close operation types", () => {
  test("the claim transaction and the merge transaction between them hold every listed type", () => {
    const everything: ScenarioSelection = {
      scenarios: [
        ...SELECTION.scenarios,
        { id: "dispositions", params: { lwcoin: 1, lwgem: 0 } },
        {
          id: "claimable-balances",
          params: { add_trustline: 0, time_gated: 0, demo_sponsored: 0 },
        },
        { id: "sponsored-reserves", params: { variant: 1 } },
      ],
    };
    const expected = claimsExpectation(everything);
    const claim = envelope([Operation.claimClaimableBalance({ balanceId: BONUS_ID })], {}, false);
    const merge = envelope([
      Operation.pathPaymentStrictSend({
        sendAsset: LWCOIN,
        sendAmount: "20",
        destination: demo,
        destAsset: Asset.native(),
        destMin: "9.95",
        path: [],
      }),
      Operation.revokeTrustlineSponsorship({ account: beneficiary, asset: PERK }),
      Operation.revokeDataSponsorship({ account: beneficiary, name: "sponsored_by_demo" }),
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
    ]);
    const types = new Set<string>();
    for (const xdrBase64 of [claim, merge]) {
      expect(outcome(xdrBase64, expected)).toBe("accepted");
      const parsed = TransactionBuilder.fromXDR(xdrBase64, PASSPHRASE);
      if (!(parsed instanceof Transaction)) throw new Error("expected a transaction");
      for (const op of parsed.operations) types.add(op.type);
    }
    expect(types).toEqual(new Set(PLAYGROUND_CLOSE_OPERATION_TYPES));
  });

  test("a type the shared anchor allows but no scenario creates is refused", () => {
    for (const op of [
      Operation.revokeAccountSponsorship({ account: demo }),
      Operation.revokeOfferSponsorship({ seller: demo, offerId: "1" }),
      Operation.revokeSignerSponsorship({ account: demo, signer: { ed25519PublicKey: forgotten } }),
    ]) {
      expect(outcome(envelope([op]))).toBe("operation_not_allowed");
    }
  });
});

describe("dispositions the session chose", () => {
  const recipient = Keypair.random().publicKey();
  /** LWCOIN converted and LWGEM transferred, beside the default selection. */
  const CHOSEN: ScenarioSelection = {
    scenarios: [...SELECTION.scenarios, { id: "dispositions", params: { lwcoin: 1, lwgem: 2 } }],
  };
  const chosen = (): PlaygroundCloseExpectation =>
    expectationFromSession(
      {
        demoPublic: demo,
        ephemeralIssuers: ISSUERS,
        recordedSigners: [forgotten],
        selection: CHOSEN,
        transferRecipient: { publicKey: recipient, encSecret: "enc" },
        helperAccounts: [],
        claimableBalances: [],
      },
      sink,
      lwdemoIssuer
    );
  const transfer = (destination: string, amount = "8", asset = LWGEM) =>
    Operation.payment({ destination, asset, amount });
  const convert = (sendAmount = "20", destMin = "9.95", sendAsset = LWCOIN) =>
    Operation.pathPaymentStrictSend({
      sendAsset,
      sendAmount,
      destination: demo,
      destAsset: Asset.native(),
      destMin,
      path: [],
    });

  test("the expectation takes the recipient and amounts from the session and the floor from configuration", () => {
    const expected = chosen();
    expect(expected.transfers).toEqual([
      { asset: `LWGEM:${lwdemoIssuer}`, destination: recipient, amount: "8" },
    ]);
    // 20 LWCOIN at 2 per XLM is 10 XLM; the floor is 1% under it.
    expect(expected.conversions).toEqual([
      { asset: `LWCOIN:${lwdemoIssuer}`, amount: "20", minAmountOut: "99000000" },
    ]);
  });

  test("a transfer without the session's recipient cannot be expected", () => {
    expect(() =>
      expectationFromSession(
        {
          demoPublic: demo,
          ephemeralIssuers: ISSUERS,
          recordedSigners: [forgotten],
          selection: CHOSEN,
          transferRecipient: null,
          helperAccounts: [],
          claimableBalances: [],
        },
        sink,
        lwdemoIssuer
      )
    ).toThrow("session_recipient_missing");
  });

  test("a transfer of the recorded amount to the recipient is accepted", () => {
    expect(outcome(envelope([transfer(recipient)]), chosen())).toBe("accepted");
  });

  test("a transfer to anyone but the recipient is refused, the issuer and the sink included", () => {
    for (const destination of [Keypair.random().publicKey(), lwdemoIssuer, sink]) {
      expect(outcome(envelope([transfer(destination)]), chosen())).toBe(
        "transfer_destination_mismatch"
      );
    }
  });

  test("a transfer above the recorded amount is refused; one below it is short", () => {
    expect(outcome(envelope([transfer(recipient, "8.0000001")]), chosen())).toBe(
      "transfer_above_recorded"
    );
    expect(outcome(envelope([transfer(recipient, "7.9999999")]), chosen())).toBe(
      "transfer_amount_short"
    );
  });

  test("a transfer of the asset the session converts is refused", () => {
    expect(outcome(envelope([transfer(recipient, "20", LWCOIN)]), chosen())).toBe(
      "transfer_not_chosen"
    );
  });

  test("a conversion of the recorded amount at the floor or above is accepted", () => {
    expect(outcome(envelope([convert("20", "9.9")]), chosen())).toBe("accepted");
    expect(outcome(envelope([convert("20", "10")]), chosen())).toBe("accepted");
  });

  test("a conversion of more than the demo holds is refused", () => {
    expect(outcome(envelope([convert("20.0000001")]), chosen())).toBe("conversion_above_held");
  });

  test("a conversion accepting less than the floor is refused", () => {
    expect(outcome(envelope([convert("20", "9.8999999")]), chosen())).toBe(
      "conversion_min_out_below_floor"
    );
  });

  test("a conversion of the asset the session transfers is refused", () => {
    expect(outcome(envelope([convert("8", "3", LWGEM)]), chosen())).toBe(
      "conversion_asset_not_chosen"
    );
  });

  test("an asset chosen to convert can no longer be returned to its issuer", () => {
    expect(outcome(envelope([returnToIssuer(LWCOIN)]), chosen())).toBe("transfer_not_chosen");
  });

  test("an asset the session burns is still returned to its issuer", () => {
    const burning: ScenarioSelection = {
      scenarios: [{ id: "dispositions", params: { lwcoin: 0, lwgem: 0 } }],
    };
    const expected = expectation(burning, []);
    expect(expected.transfers).toEqual([]);
    expect(expected.conversions).toEqual([]);
    expect(outcome(envelope([returnToIssuer(LWCOIN), returnToIssuer(LWGEM)]), expected)).toBe(
      "accepted"
    );
    expect(outcome(envelope([convert()]), expected)).toBe("conversion_asset_not_chosen");
  });

  test("each asset is held to its own recorded amount when both transfer or both convert", () => {
    const both = (choice: number): PlaygroundCloseExpectation =>
      expectationFromSession(
        {
          demoPublic: demo,
          ephemeralIssuers: [],
          recordedSigners: [],
          selection: {
            scenarios: [{ id: "dispositions", params: { lwcoin: choice, lwgem: choice } }],
          },
          transferRecipient: { publicKey: recipient, encSecret: "enc" },
          helperAccounts: [],
          claimableBalances: [],
        },
        sink,
        lwdemoIssuer
      );
    // LWCOIN's 20 must not stand in for LWGEM's 8.
    expect(outcome(envelope([transfer(recipient, "8")]), both(2))).toBe("accepted");
    expect(outcome(envelope([transfer(recipient, "8.0000001")]), both(2))).toBe(
      "transfer_above_recorded"
    );
    expect(outcome(envelope([convert("8", "3.96", LWGEM)]), both(1))).toBe("accepted");
    expect(outcome(envelope([convert("8.0000001", "3.96", LWGEM)]), both(1))).toBe(
      "conversion_above_held"
    );
  });

  test("the whole chosen close fits the operation ceiling it always had", () => {
    const ops = [
      convert(),
      Operation.changeTrust({ asset: LWCOIN, limit: "0" }),
      transfer(recipient),
      Operation.changeTrust({ asset: LWGEM, limit: "0" }),
    ];
    expect(outcome(envelope(ops), chosen())).toBe("accepted");
    expect(maxOperations(chosen())).toBe(maxOperations(expectation()) + 4);
  });
});

describe("amounts in stroops", () => {
  test("reads whole and decimal amounts exactly, and refuses anything else", () => {
    expect(amountToStroops("8")).toBe(BigInt(80_000_000));
    expect(amountToStroops("0.0000001")).toBe(BigInt(1));
    expect(amountToStroops("20.5")).toBe(BigInt(205_000_000));
    for (const bad of ["", "1.", ".5", "1.00000001", "-1", "1e3", " 1"]) {
      expect(() => amountToStroops(bad)).toThrow("amount_unreadable");
    }
  });
});

describe("the API's real transactions for the dispositions recipes", () => {
  // Built by apps/api's buildCloseTransactions (apps/api/tests/unit/playground-dispositions-recipe.test.ts)
  // with the answers the playground sends: convert at the session's floor, transfer to the
  // session's recipient, return the rest to the issuer.
  type DispositionsRecipe = (typeof dispositionsFixture.recipes)[number];

  function dispositionsExpectation(
    recipe: DispositionsRecipe,
    recipient = recipe.session.transferRecipient
  ): PlaygroundCloseExpectation {
    const selection = parseSelection(recipe.selection);
    if (!selection) throw new Error(`recipe ${recipe.name} has no readable selection`);
    return expectationFromSession(
      {
        demoPublic: recipe.session.demoPublic,
        ephemeralIssuers: [],
        recordedSigners: [],
        selection,
        transferRecipient: { publicKey: recipient, encSecret: "enc" },
        helperAccounts: [],
        claimableBalances: [],
      },
      recipe.session.sinkPublic,
      recipe.session.persistentIssuer
    );
  }

  test("every transaction verifies against its session", () => {
    setSystemTime(new Date(dispositionsFixture.builtAtSeconds * 1000));
    expect(dispositionsFixture.recipes.map((r) => r.name)).toEqual([
      "convert-and-transfer",
      "transfer-and-burn",
      "burn-and-convert",
    ]);
    for (const recipe of dispositionsFixture.recipes) {
      expect(recipe.transactions).toHaveLength(1);
      expect({
        recipe: recipe.name,
        outcome: outcome(recipe.transactions[0]!, dispositionsExpectation(recipe)),
      }).toEqual({ recipe: recipe.name, outcome: "accepted" });
    }
  });

  test("a recipe that transfers is refused for a session with another recipient", () => {
    setSystemTime(new Date(dispositionsFixture.builtAtSeconds * 1000));
    const recipe = dispositionsFixture.recipes.find((r) => r.name === "transfer-and-burn")!;
    const other = Keypair.random().publicKey();
    expect(outcome(recipe.transactions[0]!, dispositionsExpectation(recipe, other))).toBe(
      "transfer_destination_mismatch"
    );
  });

  test("a recipe that converts is refused for a session that burns instead", () => {
    setSystemTime(new Date(dispositionsFixture.builtAtSeconds * 1000));
    const recipe = dispositionsFixture.recipes.find((r) => r.name === "burn-and-convert")!;
    const burning = {
      ...recipe,
      selection: { scenarios: [{ id: "dispositions", params: { lwcoin: 0, lwgem: 0 } }] },
    };
    expect(outcome(recipe.transactions[0]!, dispositionsExpectation(burning))).toBe(
      "conversion_asset_not_chosen"
    );
  });
});

describe("claimable balances the session recorded", () => {
  const claimOf = (id: string, source?: string) =>
    Operation.claimClaimableBalance({ balanceId: id, ...(source && { source }) });
  const addTrust = (asset: Asset) => Operation.changeTrust({ asset });
  /** A transaction with no merge: the claim transaction. */
  const claimTx = (ops: xdr.Operation[]) => envelope(ops, {}, false);

  test("the expectation takes the claims, the forfeit and the trustline from the session record", () => {
    const expected = claimsExpectation();
    expect(expected.claims).toEqual([
      { id: BONUS_ID, asset: `BONUS:${bonusIssuer}`, addTrustline: false },
      { id: GIFT_ID, asset: `GIFT:${giftIssuer}`, addTrustline: true },
    ]);
    expect(expected.forfeits).toEqual([LATE_ID]);
    // GIFT arrives through the claim, so the close may return it and remove its trustline.
    expect(expected.assets.map((a) => a.code)).toContain("GIFT");
  });

  test("the API's claim transaction is accepted: trustline added, then both claims", () => {
    expect(
      outcome(claimTx([addTrust(GIFT), claimOf(BONUS_ID), claimOf(GIFT_ID)]), claimsExpectation())
    ).toBe("accepted");
  });

  test("a claim of a balance the session did not record is refused", () => {
    expect(outcome(claimTx([claimOf(balanceId("e"))]), claimsExpectation())).toBe(
      "claim_not_recorded"
    );
  });

  test("a forfeited balance is never claimed", () => {
    expect(outcome(claimTx([claimOf(LATE_ID)]), claimsExpectation())).toBe("claim_not_recorded");
  });

  test("a second claim of one balance is refused", () => {
    expect(outcome(claimTx([claimOf(BONUS_ID), claimOf(BONUS_ID)]), claimsExpectation())).toBe(
      "claim_duplicate"
    );
  });

  test("a claim sent by another account is refused", () => {
    expect(outcome(claimTx([claimOf(BONUS_ID, sink)]), claimsExpectation())).toBe(
      "operation_source_mismatch"
    );
  });

  test("a trustline add not followed by its claim is refused, even when it is claimed before", () => {
    expect(outcome(claimTx([addTrust(GIFT), claimOf(BONUS_ID)]), claimsExpectation())).toBe(
      "claim_trustline_not_followed"
    );
    expect(outcome(claimTx([claimOf(GIFT_ID), addTrust(GIFT)]), claimsExpectation())).toBe(
      "claim_trustline_not_followed"
    );
  });

  test("a trustline for an asset no recorded balance needs is refused", () => {
    expect(outcome(claimTx([addTrust(BONUS), claimOf(BONUS_ID)]), claimsExpectation())).toBe(
      "trustline_not_removal"
    );
    const stranger = new Asset("GIFT", Keypair.random().publicKey());
    expect(outcome(claimTx([addTrust(stranger), claimOf(GIFT_ID)]), claimsExpectation())).toBe(
      "trustline_not_removal"
    );
  });

  test("a second trustline add for one asset is refused", () => {
    expect(
      outcome(claimTx([addTrust(GIFT), addTrust(GIFT), claimOf(GIFT_ID)]), claimsExpectation())
    ).toBe("claim_trustline_duplicate");
  });

  test("the claim transaction holds nothing but claims and their trustlines", () => {
    const removal = Operation.manageData({ name: "promo_code", value: null });
    expect(outcome(claimTx([claimOf(BONUS_ID), removal]), claimsExpectation())).toBe(
      "merge_not_final"
    );
    expect(outcome(claimTx([claimOf(BONUS_ID), returnToIssuer(BONUS)]), claimsExpectation())).toBe(
      "merge_not_final"
    );
  });

  test("a transaction without a merge is refused for a session that recorded no claims", () => {
    expect(outcome(claimTx([claimOf(BONUS_ID)]))).toBe("merge_not_final");
    const noClaims = expectation(
      {
        scenarios: [{ id: "claimable-balances", params: {} }],
      },
      [
        { assetCode: "BONUS", publicKey: bonusIssuer, encSecret: "enc" },
        { assetCode: "GIFT", publicKey: giftIssuer, encSecret: "enc" },
      ]
    );
    expect(noClaims.claims).toEqual([]);
    expect(outcome(claimTx([claimOf(BONUS_ID)]), noClaims)).toBe("merge_not_final");
  });

  test("a claim or a trustline add in the merge transaction is refused", () => {
    expect(outcome(envelope([claimOf(BONUS_ID)]), claimsExpectation())).toBe(
      "claim_outside_claim_transaction"
    );
    expect(outcome(envelope([addTrust(GIFT)]), claimsExpectation())).toBe(
      "trustline_add_outside_claim_transaction"
    );
  });

  test("after the claims, the merge transaction returns both assets and removes both trustlines", () => {
    const ops = [
      returnToIssuer(BONUS),
      returnToIssuer(GIFT),
      Operation.changeTrust({ asset: BONUS, limit: "0" }),
      Operation.changeTrust({ asset: GIFT, limit: "0" }),
    ];
    expect(outcome(envelope(ops), claimsExpectation())).toBe("accepted");
  });
});

describe("sponsorships the session recorded", () => {
  const revokeTrust = (account: string, asset: Asset, source?: string) =>
    Operation.revokeTrustlineSponsorship({ account, asset, ...(source && { source }) });
  const revokeData = (account: string, name: string, source?: string) =>
    Operation.revokeDataSponsorship({ account, name, ...(source && { source }) });

  test("revoking both recorded entries, once each, is accepted", () => {
    const ops = [revokeTrust(beneficiary, PERK), revokeData(beneficiary, "sponsored_by_demo")];
    expect(outcome(envelope(ops), claimsExpectation())).toBe("accepted");
    // One revoke per recorded entry fits the operation ceiling.
    expect(maxOperations(claimsExpectation())).toBe(maxOperations(expectation()) + 2 * 2 + 2);
  });

  test("a revoke of an entry the session did not record is refused", () => {
    for (const op of [
      revokeTrust(Keypair.random().publicKey(), PERK),
      revokeTrust(beneficiary, BONUS),
      revokeData(beneficiary, "promo_code"),
      revokeData(demo, "sponsored_by_demo"),
    ]) {
      expect(outcome(envelope([op]), claimsExpectation())).toBe("revoke_not_recorded");
    }
  });

  test("a revoke sourced from another account is refused", () => {
    expect(outcome(envelope([revokeTrust(beneficiary, PERK, sink)]), claimsExpectation())).toBe(
      "operation_source_mismatch"
    );
  });

  test("a second revoke of one entry is refused", () => {
    const op = revokeData(beneficiary, "sponsored_by_demo");
    expect(outcome(envelope([op, op]), claimsExpectation())).toBe("revoke_duplicate");
  });

  test("a claimable balance's sponsorship is never revoked", () => {
    const op = Operation.revokeClaimableBalanceSponsorship({ balanceId: BONUS_ID });
    expect(outcome(envelope([op]), claimsExpectation())).toBe("revoke_claimable_balance_refused");
    expect(outcome(envelope([op], {}, false), claimsExpectation())).toBe(
      "revoke_claimable_balance_refused"
    );
  });

  test("entries the demo sponsors without a beneficiary on record cannot be expected", () => {
    expect(() =>
      expectationFromSession(
        {
          demoPublic: demo,
          ephemeralIssuers: [{ assetCode: "PERK", publicKey: perkIssuer, encSecret: "enc" }],
          recordedSigners: [],
          selection: { scenarios: [{ id: "sponsored-reserves", params: { variant: 2 } }] },
          transferRecipient: null,
          helperAccounts: [],
          claimableBalances: [],
        },
        sink,
        lwdemoIssuer
      )
    ).toThrow("session_beneficiary_missing");
  });
});

describe("the API's real transactions for the claims and sponsoring recipes", () => {
  // Built by apps/api's buildCloseTransactions (apps/api/tests/unit/playground-claims-recipe.test.ts)
  // with the answers the playground sends.
  type ClaimsRecipe = (typeof claimsFixture.recipes)[number];
  const HELPER_ROLES = ["claimant", "sponsor", "beneficiary"] as const;
  const INTENTS = ["claim", "add_trustline_then_claim", "forfeit", "demo_sponsored"] as const;

  function claimsRecipeExpectation(
    recipe: ClaimsRecipe,
    over: {
      claimableBalances?: ClaimsRecipe["session"]["claimableBalances"];
      beneficiary?: string;
    } = {}
  ): PlaygroundCloseExpectation {
    const selection = parseSelection(recipe.selection);
    if (!selection) throw new Error(`recipe ${recipe.name} has no readable selection`);
    const { session } = recipe;
    return expectationFromSession(
      {
        demoPublic: session.demoPublic,
        ephemeralIssuers: session.ephemeralIssuers.map((e) => ({ ...e, encSecret: "enc" })),
        recordedSigners: [],
        selection,
        transferRecipient: null,
        helperAccounts: session.helperAccounts.map((h) => {
          const role = HELPER_ROLES.find((r) => r === h.role);
          if (!role) throw new Error(`unknown helper role ${h.role}`);
          return { role, publicKey: over.beneficiary ?? h.publicKey, encSecret: "enc" };
        }),
        claimableBalances: (over.claimableBalances ?? session.claimableBalances).map((b) => {
          const intent = INTENTS.find((i) => i === b.intent);
          if (!intent) throw new Error(`unknown intent ${b.intent}`);
          return { ...b, intent };
        }),
      },
      session.sinkPublic,
      lwdemoIssuer
    );
  }
  const recipe = (name: string): ClaimsRecipe => {
    const found = claimsFixture.recipes.find((r) => r.name === name);
    if (!found) throw new Error(`no recipe ${name}`);
    return found;
  };

  test("every transaction verifies against its session, the claim transaction first", () => {
    setSystemTime(new Date(claimsFixture.builtAtSeconds * 1000));
    expect(claimsFixture.recipes.map((r) => [r.name, r.transactions.length])).toEqual([
      ["claimable", 2],
      ["sponsoring", 1],
    ]);
    for (const r of claimsFixture.recipes) {
      for (const tx of r.transactions) {
        expect({ recipe: r.name, outcome: outcome(tx, claimsRecipeExpectation(r)) }).toEqual({
          recipe: r.name,
          outcome: "accepted",
        });
      }
    }
  });

  test("the claim transaction is refused when the session did not record a balance it claims", () => {
    setSystemTime(new Date(claimsFixture.builtAtSeconds * 1000));
    const claimable = recipe("claimable");
    const withoutGift = claimable.session.claimableBalances.filter(
      (b) => b.intent !== "add_trustline_then_claim"
    );
    expect(
      outcome(
        claimable.transactions[0]!,
        claimsRecipeExpectation(claimable, { claimableBalances: withoutGift })
      )
    ).toBe("trustline_not_removal");
  });

  test("the sponsoring close is refused for a session with another beneficiary", () => {
    setSystemTime(new Date(claimsFixture.builtAtSeconds * 1000));
    const sponsoring = recipe("sponsoring");
    expect(
      outcome(
        sponsoring.transactions[0]!,
        claimsRecipeExpectation(sponsoring, { beneficiary: Keypair.random().publicKey() })
      )
    ).toBe("revoke_not_recorded");
  });
});
