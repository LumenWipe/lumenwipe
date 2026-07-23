import { test, expect } from "bun:test";
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { validateSignRequest, MAX_FEE_STROOPS } from "@/lib/playground/validate-sign";

const demo = Keypair.random();
const mm = Keypair.random();
const issuer = Keypair.random();
const attacker = Keypair.random();

const ctx = {
  demoPublic: demo.publicKey(),
  allowedDestinations: new Set([demo.publicKey(), mm.publicKey(), issuer.publicKey()]),
};

function buildTx(opts: {
  source?: string;
  fee?: string;
  ops: ReturnType<typeof Operation.payment>[];
}): string {
  const builder = new TransactionBuilder(new Account(opts.source ?? demo.publicKey(), "1"), {
    fee: opts.fee ?? "100",
    networkPassphrase: Networks.TESTNET,
  }).setTimeout(300);
  opts.ops.forEach((op) => builder.addOperation(op));
  return builder.build().toEnvelope().toXDR("base64");
}

const mergeToMm = () => Operation.accountMerge({ destination: mm.publicKey() });

test("accepts a merge to the market maker", () => {
  const result = validateSignRequest(buildTx({ ops: [mergeToMm()] }), ctx);
  expect(result.ok).toBe(true);
});

test("accepts removing a trustline and data entry", () => {
  const xdr = buildTx({
    ops: [
      Operation.changeTrust({ asset: new Asset("AIRDROP1", issuer.publicKey()), limit: "0" }),
      Operation.manageData({ name: "promo_code", value: null }),
    ],
  });
  expect(validateSignRequest(xdr, ctx).ok).toBe(true);
});

test("rejects garbage XDR", () => {
  const result = validateSignRequest("AAAA-not-xdr", ctx);
  expect(result).toEqual({ ok: false, error: "invalid_xdr" });
});

test("rejects a tx whose source is not the session demo account", () => {
  const xdr = buildTx({ source: attacker.publicKey(), ops: [mergeToMm()] });
  expect(validateSignRequest(xdr, ctx)).toEqual({ ok: false, error: "source_not_allowed" });
});

test("rejects fees above the cap", () => {
  const xdr = buildTx({ fee: String(MAX_FEE_STROOPS + 1), ops: [mergeToMm()] });
  expect(validateSignRequest(xdr, ctx)).toEqual({ ok: false, error: "fee_too_high" });
});

test("rejects payments to destinations outside the session", () => {
  const xdr = buildTx({
    ops: [
      Operation.payment({
        destination: attacker.publicKey(),
        asset: Asset.native(),
        amount: "10",
      }),
    ],
  });
  expect(validateSignRequest(xdr, ctx)).toEqual({ ok: false, error: "destination_not_allowed" });
});

test("rejects a merge to an external destination", () => {
  const xdr = buildTx({ ops: [Operation.accountMerge({ destination: attacker.publicKey() })] });
  expect(validateSignRequest(xdr, ctx)).toEqual({ ok: false, error: "destination_not_allowed" });
});

test("rejects non-whitelisted operation types", () => {
  const xdr = buildTx({
    ops: [Operation.bumpSequence({ bumpTo: "999999999" })],
  });
  expect(validateSignRequest(xdr, ctx)).toEqual({
    ok: false,
    error: "op_not_allowed:bumpSequence",
  });
});

test("rejects ops sourced from another account", () => {
  const xdr = buildTx({
    ops: [
      Operation.payment({
        source: mm.publicKey(),
        destination: demo.publicKey(),
        asset: Asset.native(),
        amount: "10",
      }),
    ],
  });
  expect(validateSignRequest(xdr, ctx)).toEqual({ ok: false, error: "op_source_not_allowed" });
});
