import { describe, expect, test } from "bun:test";
import {
  Account,
  Asset,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { VerificationError } from "@lumenwipe/verify";
import type { AccountState, CloseTransaction, DecisionPoint } from "../../src/index";
import {
  buildDecisions,
  destinationDecisionId,
  verifyCloseTransaction,
} from "../../examples/verify";

const source = Keypair.random().publicKey();
const destination = Keypair.random().publicKey();
const other = Keypair.random().publicKey();

function closeTx(
  ops: xdr.Operation[],
  extra: Partial<CloseTransaction> = {},
  options: { memo?: Memo; txSource?: string } = {}
): CloseTransaction {
  const builder = new TransactionBuilder(new Account(options.txSource ?? source, "1"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
    memo: options.memo,
  }).setTimeout(60);
  for (const op of ops) builder.addOperation(op);
  return { xdr: builder.build().toEnvelope().toXdr("base64"), ...extra } as CloseTransaction;
}

/** The account read the example passes on: one master key, no positions. */
const account = {
  address: source,
  nativeBalanceLumens: "100.0000000",
  signers: [{ key: source, weight: 1, type: "ed25519_public_key" }],
  thresholds: { low: 0, med: 0, high: 0 },
  trustlines: [],
  defiPositions: { positions: [] },
} as unknown as AccountState;

const expected = { account, destination, network: "testnet" as const };

/** The refusal comes from `@lumenwipe/verify`, never from a check of the example's own. */
function expectRefusal(tx: CloseTransaction, message: string): void {
  expect(() => verifyCloseTransaction(tx, expected)).toThrow(VerificationError);
  expect(() => verifyCloseTransaction(tx, expected)).toThrow(message);
}

describe("verifyCloseTransaction", () => {
  test("accepts removals followed by a merge to the stated destination", () => {
    const tx = closeTx([
      Operation.manageData({ name: "k", value: null }),
      Operation.accountMerge({ destination }),
    ]);
    expect(() => verifyCloseTransaction(tx, expected)).not.toThrow();
  });

  test("rejects a merge to any other account", () => {
    const tx = closeTx([Operation.accountMerge({ destination: other })]);
    expectRefusal(tx, "The account would be merged to an address you did not choose.");
  });

  test("rejects a transaction sourced from another account", () => {
    const tx = closeTx([Operation.accountMerge({ destination })], {}, { txSource: other });
    expectRefusal(tx, "The transaction is not for your account.");
  });

  test("rejects a merge sourced from another account", () => {
    const tx = closeTx([Operation.accountMerge({ destination, source: other })]);
    expectRefusal(tx, "The account merge is not sent by the account being closed.");
  });

  test("rejects a payment the user did not choose", () => {
    const tx = closeTx([
      Operation.payment({ destination: other, asset: Asset.native(), amount: "1" }),
    ]);
    expectRefusal(tx, `The transaction would pay funds to an unexpected address (${other}).`);
  });

  test("rejects a data entry write", () => {
    const tx = closeTx([Operation.manageData({ name: "k", value: "v" })]);
    expectRefusal(tx, "A data entry would be written, not removed.");
  });

  test("rejects a trustline that is not being removed", () => {
    const asset = new Asset("USD", Keypair.random().publicKey());
    const tx = closeTx([Operation.changeTrust({ asset, limit: "10" })]);
    expectRefusal(tx, "A trustline would be created or raised, not removed.");
  });

  test("accepts removing a trustline and cancelling an offer", () => {
    const asset = new Asset("USD", Keypair.random().publicKey());
    const tx = closeTx([
      Operation.manageSellOffer({
        selling: asset,
        buying: Asset.native(),
        amount: "0",
        price: "1",
        offerId: "7",
      }),
      Operation.changeTrust({ asset, limit: "0" }),
      Operation.accountMerge({ destination }),
    ]);
    expect(() => verifyCloseTransaction(tx, expected)).not.toThrow();
  });

  test("rejects an offer that is not being cancelled", () => {
    const tx = closeTx([
      Operation.manageSellOffer({
        selling: Asset.native(),
        buying: new Asset("USD", Keypair.random().publicKey()),
        amount: "5",
        price: "1",
        offerId: "7",
      }),
    ]);
    expectRefusal(tx, "An offer would be created, not cancelled.");
  });

  test("rejects a memo the user did not ask for", () => {
    const tx = closeTx([Operation.accountMerge({ destination })], {}, { memo: Memo.text("x") });
    expectRefusal(tx, "The transaction carries a memo you did not set.");
  });

  test("rejects a fee-sponsored transaction", () => {
    const tx = closeTx([Operation.accountMerge({ destination })], { needsSponsoredFee: true });
    expect(() => verifyCloseTransaction(tx, expected)).toThrow("fee-sponsored");
  });
});

describe("buildDecisions", () => {
  const point = (id: string, required: boolean): DecisionPoint => ({
    id,
    type: "asset_disposition",
    subject: {},
    options: [],
    default: "",
    required,
  });

  test("acknowledges the destination when the plan asks", () => {
    expect(buildDecisions([point(destinationDecisionId(destination), true)], destination)).toEqual([
      { id: destinationDecisionId(destination), choice: "i_control_this_address" },
    ]);
  });

  test("answers nothing for a destination point the plan did not offer", () => {
    expect(buildDecisions([], destination)).toEqual([]);
    expect(buildDecisions([point(destinationDecisionId(other), false)], destination)).toEqual([]);
  });

  test("ignores optional points and the destination point itself", () => {
    const points = [point(destinationDecisionId(destination), true), point("asset:X", false)];
    expect(buildDecisions(points, destination)).toHaveLength(1);
  });

  test("refuses a required decision it cannot make", () => {
    expect(() => buildDecisions([point("asset:USDC-G", true)], destination)).toThrow(
      "asset:USDC-G"
    );
  });
});
