import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { HttpException } from "@nestjs/common";
import {
  Account,
  Asset,
  FeeBumpTransaction,
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { FeeBumpController } from "@/fee-bump/fee-bump.controller";
import { MAX_FEE_BUMP_STROOPS } from "@/config/constants";

const SOURCE = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const FEE_ACCOUNT = Keypair.random();

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.FEE_ACCOUNT_SECRET_TESTNET = FEE_ACCOUNT.secret();
  delete process.env.FEE_ACCOUNT_SECRET_MAINNET;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

/** A plain, inner-fee-zero transaction with the given operations, exactly as the close builder
 *  would leave it - unsigned or signed, either way (the controller does not check signatures). */
function windDownTx(...ops: ReturnType<typeof Operation.payment>[]): string {
  const tx = new TransactionBuilder(new Account(SOURCE, "1"), {
    fee: "0",
    networkPassphrase: Networks.TESTNET,
  });
  for (const op of ops) tx.addOperation(op);
  return tx.setTimeout(30).build().toXDR();
}

async function expectFail(promise: Promise<unknown>, status: number, code: string): Promise<void> {
  try {
    await promise;
    throw new Error("expected the call to reject");
  } catch (err) {
    expect(err).toBeInstanceOf(HttpException);
    const e = err as HttpException;
    expect(e.getStatus()).toBe(status);
    expect((e.getResponse() as { error: { code: string } }).error.code).toBe(code);
  }
}

describe("FeeBumpController.sponsor", () => {
  const controller = new FeeBumpController();

  test("wraps a wind-down transaction in a fee-bump envelope, signed by the fee account, unsigned by anything else", async () => {
    const xdr = windDownTx(Operation.accountMerge({ destination: DEST }));
    const { transaction } = await controller.sponsor("testnet", { transaction: xdr });

    const parsed = TransactionBuilder.fromXDR(transaction, Networks.TESTNET);
    expect(parsed).toBeInstanceOf(FeeBumpTransaction);
    const feeBump = parsed as FeeBumpTransaction;
    expect(feeBump.feeSource).toBe(FEE_ACCOUNT.publicKey());
    expect(feeBump.innerTransaction.toXDR()).toBe(
      (TransactionBuilder.fromXDR(xdr, Networks.TESTNET) as Transaction).toXDR()
    );
    // Signed by the fee account and nothing else - the inner transaction's own signatures (or
    // lack of them) are untouched, and this wrapper carries none of its own besides the sponsor's.
    expect(feeBump.signatures).toHaveLength(1);
    const sigOk = FEE_ACCOUNT.verify(feeBump.hash(), feeBump.signatures[0]!.signature());
    expect(sigOk).toBe(true);
    // The fee is capped and computed from the fee account's own choice of base fee, never from
    // anything the caller supplied.
    expect(BigInt(feeBump.fee)).toBeGreaterThan(0n);
    expect(BigInt(feeBump.fee)).toBeLessThanOrEqual(BigInt(MAX_FEE_BUMP_STROOPS));
  });

  test("refuses when the sponsor is not configured for the network - mainnet unaffected by testnet's key", async () => {
    await expectFail(
      controller.sponsor("mainnet", {
        transaction: windDownTx(Operation.accountMerge({ destination: DEST })),
      }),
      503,
      "fee_bump_not_configured"
    );
  });

  test("refuses a missing or unparseable transaction", async () => {
    await expectFail(controller.sponsor("testnet", {}), 400, "missing_transaction");
    await expectFail(
      controller.sponsor("testnet", { transaction: "not xdr" }),
      400,
      "invalid_transaction_xdr"
    );
  });

  test("refuses to sponsor a second fee-bump - CAP-15 has no such construct", async () => {
    const inner = windDownTx(Operation.accountMerge({ destination: DEST }));
    const nested = TransactionBuilder.buildFeeBumpTransaction(
      Keypair.random(),
      "100",
      TransactionBuilder.fromXDR(inner, Networks.TESTNET) as Transaction,
      Networks.TESTNET
    );
    await expectFail(
      controller.sponsor("testnet", { transaction: nested.toXDR() }),
      400,
      "invalid_transaction_xdr"
    );
  });

  test("refuses an inner transaction whose own fee is not zero", async () => {
    const tx = new TransactionBuilder(new Account(SOURCE, "1"), {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.accountMerge({ destination: DEST }))
      .setTimeout(30)
      .build();
    await expectFail(
      controller.sponsor("testnet", { transaction: tx.toXDR() }),
      400,
      "inner_fee_not_zero"
    );
  });

  test("refuses an empty transaction and one carrying any non-wind-down operation", async () => {
    const empty = new TransactionBuilder(new Account(SOURCE, "1"), {
      fee: "0",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.bumpSequence({ bumpTo: "2" }))
      .setTimeout(30)
      .build();
    // bumpSequence stands in for "not a wind-down op"; there is no zero-operation builder path.
    await expectFail(
      controller.sponsor("testnet", { transaction: empty.toXDR() }),
      400,
      "operation_not_sponsorable"
    );

    const mixed = windDownTx(
      Operation.accountMerge({ destination: DEST }),
      Operation.payment({ destination: DEST, asset: Asset.native(), amount: "1" })
    );
    await expectFail(
      controller.sponsor("testnet", { transaction: mixed }),
      400,
      "operation_not_sponsorable"
    );
  });

  test("sponsors a fully batched wind-down (signer removal, offer/trustline cleanup, merge) in one call", async () => {
    const issuer = Keypair.random().publicKey();
    const asset = new Asset("USDC", issuer);
    const xdr = windDownTx(
      Operation.setOptions({
        signer: { ed25519PublicKey: Keypair.random().publicKey(), weight: 0 },
      }),
      Operation.manageSellOffer({
        selling: asset,
        buying: Asset.native(),
        amount: "0",
        price: "1",
      }),
      Operation.manageData({ name: "x", value: null }),
      Operation.changeTrust({ asset, limit: "0" }),
      Operation.accountMerge({ destination: DEST })
    );
    const { transaction } = await controller.sponsor("testnet", { transaction: xdr });
    const feeBump = TransactionBuilder.fromXDR(transaction, Networks.TESTNET) as FeeBumpTransaction;
    expect(feeBump.innerTransaction.operations).toHaveLength(5);
  });

  test("rejects an invalid network before touching configuration", async () => {
    await expectFail(
      controller.sponsor("betanet", {
        transaction: windDownTx(Operation.accountMerge({ destination: DEST })),
      }),
      400,
      "invalid_network"
    );
  });
});
