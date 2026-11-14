import { describe, expect, test } from "bun:test";
import {
  FeeBumpTransaction,
  Memo,
  Networks,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { readReceipt } from "@/lib/receipt";
import { networkStroops } from "@/lib/stroops";
import captured from "../fixtures/receipt-testnet.json";

// The receipt parser against transactions recorded from the public testnet.
//
// Provenance: tests/fixtures/receipt-testnet.json holds four transactions created on testnet for
// this test on the date in each record's `capturedAt`, from accounts funded by Friendbot whose keys
// were generated in memory and discarded. Each record is what Horizon returned for it
// (`/transactions/{hash}`: the hash it was looked up by, successful, envelope_xdr, result_xdr, fee_charged, fee_account,
// memo), the operation types, and the `account_credited` effects of the transaction, which the
// assertions below hold the parser to. They are:
//   classic   - a data entry removal and a merge into a destination, paid by the account;
//   sponsored - a merge inside a fee bump paid by another account, recorded under its inner hash;
//   exchange  - a merge into a relay that forwards the balance less 0.01 XLM with an id memo;
//   soroban   - a contract call (a native transfer through its asset contract), no merge.

interface Fixture {
  name: string;
  capturedAt: string;
  account: string;
  hash: string;
  horizon: {
    hash: string;
    successful: boolean;
    envelope_xdr: string;
    result_xdr: string;
    fee_charged: string;
    fee_account: string;
    memo: string | null;
  };
  operations: string[];
  credited: { account: string; amount: string }[];
}

const fixtures = captured as Fixture[];
const fixture = (name: string): Fixture => {
  const found = fixtures.find((f) => f.name === name);
  if (!found) throw new Error(`No ${name} fixture`);
  return found;
};

const recordOf = (f: Fixture) => ({
  successful: f.horizon.successful,
  envelopeXdr: f.horizon.envelope_xdr,
  resultXdr: f.horizon.result_xdr,
});

const stroopsOf = (amount: string): string => networkStroops(amount).toString();

/** The fee bump's own hash; Horizon answers a lookup by inner hash under that inner hash. */
function outerHash(f: Fixture): string {
  const envelope = TransactionBuilder.fromXDR(f.horizon.envelope_xdr, Networks.TESTNET);
  if (!(envelope instanceof FeeBumpTransaction)) throw new Error("not a fee bump");
  return Buffer.from(envelope.hash()).toString("hex");
}

describe("a receipt read from a recorded testnet transaction", () => {
  test("classic close: the fee charged, paid by the account, and the merge credited", () => {
    const f = fixture("classic");
    const receipt = readReceipt(recordOf(f), f.hash, f.account);
    expect(receipt).toEqual({
      hash: f.hash,
      status: "read",
      feeStroops: f.horizon.fee_charged,
      feePaidBy: "account",
      operations: [
        { type: "manageData", count: 1 },
        { type: "accountMerge", count: 1 },
      ],
      merge: {
        into: "destination",
        amountStroops: stroopsOf(f.credited[0]!.amount),
        destination: f.credited[0]!.account,
      },
    });
    expect(f.horizon.fee_account).toBe(f.account);
  });

  test("sponsored close, read by its inner hash: the outer fee, paid by the sponsor", () => {
    const f = fixture("sponsored");
    expect(f.hash).not.toBe(outerHash(f));
    const receipt = readReceipt(recordOf(f), f.hash, f.account);
    expect(receipt).toEqual(
      expect.objectContaining({
        status: "read",
        feeStroops: f.horizon.fee_charged,
        feePaidBy: "sponsor",
        merge: {
          into: "destination",
          amountStroops: stroopsOf(f.credited[0]!.amount),
          destination: f.credited[0]!.account,
        },
      })
    );
    expect(f.horizon.fee_account).not.toBe(f.account);
  });

  test("sponsored close, read by its outer hash, reads the same", () => {
    const f = fixture("sponsored");
    const receipt = readReceipt(recordOf(f), outerHash(f), f.account);
    expect(receipt).toEqual(
      expect.objectContaining({ status: "read", feeStroops: f.horizon.fee_charged })
    );
  });

  test("exchange close: merged into the relay, which forwarded the deposit with its memo", () => {
    const f = fixture("exchange");
    const receipt = readReceipt(recordOf(f), f.hash, f.account);
    const [relay, standIn] = f.credited;
    if (receipt.status !== "read") throw new Error(receipt.status);
    expect(receipt.feeStroops).toBe(f.horizon.fee_charged);
    expect(receipt.merge).toEqual({
      into: "relay",
      amountStroops: stroopsOf(relay!.amount),
      forwarded: {
        amountStroops: stroopsOf(standIn!.amount),
        to: standIn!.account,
        memo: f.horizon.memo,
      },
    });
  });

  test("a hash memo on the forward reads as lowercase hex", () => {
    const f = fixture("exchange");
    const recorded = TransactionBuilder.fromXDR(f.horizon.envelope_xdr, Networks.TESTNET);
    if (!(recorded instanceof Transaction)) throw new Error("not a transaction");
    const memo = "0f".repeat(32);
    const builder = TransactionBuilder.cloneFrom(recorded, { fee: recorded.fee });
    builder.addMemo(Memo.hash(memo));
    const rebuilt = builder.build();
    const hash = Buffer.from(rebuilt.hash()).toString("hex");
    const record = { ...recordOf(f), envelopeXdr: rebuilt.toXDR() };
    const receipt = readReceipt(record, hash, f.account);
    if (receipt.status !== "read" || receipt.merge?.into !== "relay") throw new Error("not read");
    expect(receipt.merge.forwarded.memo).toBe(memo);
  });

  test("a merge sourced by another account is not the account's merge", () => {
    const f = fixture("exchange");
    const relay = f.credited[0]!.account;
    const receipt = readReceipt(recordOf(f), f.hash, relay);
    expect(receipt).toEqual(expect.objectContaining({ status: "read", merge: null }));
  });

  test("contract call: the fee charged after its refund, and no merge", () => {
    const f = fixture("soroban");
    const receipt = readReceipt(recordOf(f), f.hash, f.account);
    expect(receipt).toEqual({
      hash: f.hash,
      status: "read",
      feeStroops: f.horizon.fee_charged,
      feePaidBy: "account",
      operations: [{ type: "invokeHostFunction", count: 1 }],
      merge: null,
    });
  });
});

describe("a record that is not the transaction asked for", () => {
  test("a different transaction under the hash reads as unavailable", () => {
    const f = fixture("classic");
    const other = fixture("sponsored");
    expect(readReceipt(recordOf(f), other.hash, f.account)).toEqual({
      hash: other.hash,
      status: "unavailable",
    });
  });

  test("a transaction that does not concern the account reads as unavailable", () => {
    const f = fixture("classic");
    const stranger = fixture("soroban").account;
    expect(readReceipt(recordOf(f), f.hash, stranger)).toEqual({
      hash: f.hash,
      status: "unavailable",
    });
  });

  test("operation results that do not line up with the operations read as unavailable", () => {
    const f = fixture("classic");
    const wire = xdr.TransactionResult.fromXDR(f.horizon.result_xdr, "base64").toXdrObject();
    if (wire.result.code !== 0) throw new Error("not a success");
    const results = wire.result.results;
    const extra = {
      ...wire,
      result: { ...wire.result, results: [...results, results[results.length - 1]!] },
    };
    const resultXdr = xdr.TransactionResult.fromXdrObject(extra).toXDR("base64");
    expect(readReceipt({ ...recordOf(f), resultXdr }, f.hash, f.account)).toEqual({
      hash: f.hash,
      status: "unavailable",
    });
  });

  test("an unreadable record reads as unavailable", () => {
    const f = fixture("classic");
    const broken = { ...recordOf(f), resultXdr: "AAAA" };
    expect(readReceipt(broken, f.hash, f.account).status).toBe("unavailable");
  });

  test("a transaction the ledger reports failed keeps its fee and reads no merge", () => {
    const f = fixture("classic");
    const receipt = readReceipt({ ...recordOf(f), successful: false }, f.hash, f.account);
    expect(receipt).toEqual({
      hash: f.hash,
      status: "failed",
      feeStroops: f.horizon.fee_charged,
      feePaidBy: "account",
    });
  });
});
