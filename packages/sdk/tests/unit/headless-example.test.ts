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
import type { CloseTransaction, DecisionPoint } from "../../src/index";
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
  return { xdr: builder.build().toEnvelope().toXDR("base64"), ...extra } as CloseTransaction;
}

const expected = { source, destination };

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
    expect(() => verifyCloseTransaction(tx, expected)).toThrow("not the requested destination");
  });

  test("rejects a transaction sourced from another account", () => {
    const tx = closeTx([Operation.accountMerge({ destination })], {}, { txSource: other });
    expect(() => verifyCloseTransaction(tx, expected)).toThrow("not the account being closed");
  });

  test("rejects an operation sourced from another account", () => {
    const tx = closeTx([Operation.accountMerge({ destination, source: other })]);
    expect(() => verifyCloseTransaction(tx, expected)).toThrow("different account");
  });

  test("rejects payments", () => {
    const tx = closeTx([
      Operation.payment({ destination: other, asset: Asset.native(), amount: "1" }),
    ]);
    expect(() => verifyCloseTransaction(tx, expected)).toThrow("Unsupported operation");
  });

  test("rejects a data entry write", () => {
    const tx = closeTx([Operation.manageData({ name: "k", value: "v" })]);
    expect(() => verifyCloseTransaction(tx, expected)).toThrow("writes instead of removes");
  });

  test("rejects a trustline that is not being removed", () => {
    const asset = new Asset("USD", Keypair.random().publicKey());
    const tx = closeTx([Operation.changeTrust({ asset, limit: "10" })]);
    expect(() => verifyCloseTransaction(tx, expected)).toThrow("does not remove");
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
    expect(() => verifyCloseTransaction(tx, expected)).toThrow("does not cancel");
  });

  test("rejects a memo the user did not ask for", () => {
    const tx = closeTx([Operation.accountMerge({ destination })], {}, { memo: Memo.text("x") });
    expect(() => verifyCloseTransaction(tx, expected)).toThrow("memo");
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

  test("always acknowledges the destination", () => {
    expect(buildDecisions([], destination)).toEqual([
      { id: destinationDecisionId(destination), choice: "i_control_this_address" },
    ]);
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
