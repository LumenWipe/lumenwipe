import { describe, expect, mock, setSystemTime, test } from "bun:test";
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
import vectors from "@lumenwipe/verify/vectors/close-v1.json";
import type { AccountState, CloseTransaction, MediatorCheckResult } from "../../src/index";
import {
  EXCHANGE_DESTINATION,
  NETWORK,
  assertMediatorReady,
  assertTestnetOnly,
  cosignMerge,
  needsCosign,
} from "../../examples/exchange-close";
import { verifyCloseTransaction } from "../../examples/verify";
import {
  MediatorUnavailableError,
  assertCosignOnlyAddedSignature,
  describeError,
} from "../../examples/support";

const passphrase = Networks.TESTNET;
const user = Keypair.random();
const mediator = Keypair.random();
const wallet = Keypair.random().publicKey();

function envelope(ops: xdr.Operation[], memo?: Memo): string {
  const builder = new TransactionBuilder(new Account(user.publicKey(), "1"), {
    fee: "200",
    networkPassphrase: passphrase,
    memo,
  }).setTimeout(60);
  for (const op of ops) builder.addOperation(op);
  const tx = builder.build();
  tx.sign(user);
  return tx.toEnvelope().toXdr("base64");
}

const mediatedPair = (to: string): string =>
  envelope(
    [
      Operation.accountMerge({ destination: mediator.publicKey() }),
      Operation.payment({
        source: mediator.publicKey(),
        destination: to,
        asset: Asset.native(),
        amount: "99.9999800",
      }),
    ],
    Memo.text("deposit-1")
  );

const cleanup = (): string => envelope([Operation.manageData({ name: "k", value: null })]);

function addSignature(signedXdr: string, keypair: Keypair): string {
  const tx = TransactionBuilder.fromXdr(signedXdr, passphrase);
  tx.sign(keypair);
  return tx.toEnvelope().toXdr("base64");
}

const anyTx = {} as CloseTransaction;

describe("network guard", () => {
  test("the example's network is testnet", () => {
    expect(NETWORK).toBe("testnet");
    expect(() => assertTestnetOnly(NETWORK)).not.toThrow();
  });

  test("refuses mainnet", () => {
    expect(() => assertTestnetOnly("mainnet")).toThrow("testnet only");
  });
});

describe("assertMediatorReady", () => {
  const check = (available: boolean, registryFresh: boolean): MediatorCheckResult => ({
    requiresMediator: true,
    reason: "",
    requiresMemo: true,
    memoType: "text",
    exchangeName: "Coinbase",
    available,
    registryFresh,
  });

  test("passes for a listed exchange the API can co-sign for", () => {
    expect(() => assertMediatorReady(check(true, true), EXCHANGE_DESTINATION)).not.toThrow();
  });

  test("refuses a destination the bundled registry does not list, whatever the API says", () => {
    expect(() => assertMediatorReady(check(true, true), wallet)).toThrow("bundled registry");
  });

  test("refuses with typed fields when the API has no intermediary key", () => {
    let caught: unknown;
    try {
      assertMediatorReady(check(false, true), EXCHANGE_DESTINATION);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MediatorUnavailableError);
    expect(describeError(caught)).toEqual([
      expect.stringContaining("MediatorUnavailableError: The API has no intermediary key"),
      `  destination: ${EXCHANGE_DESTINATION}`,
      "  available: false",
      "  registryFresh: true",
    ]);
  });

  test("refuses when the registry is stale", () => {
    expect(() => assertMediatorReady(check(true, false), EXCHANGE_DESTINATION)).toThrow(
      MediatorUnavailableError
    );
  });
});

describe("needsCosign", () => {
  test("only the merge of a close to a listed exchange", () => {
    expect(needsCosign(mediatedPair(EXCHANGE_DESTINATION), EXCHANGE_DESTINATION, passphrase)).toBe(
      true
    );
    expect(needsCosign(cleanup(), EXCHANGE_DESTINATION, passphrase)).toBe(false);
  });

  test("never for a destination the bundled registry does not list", () => {
    expect(needsCosign(mediatedPair(wallet), wallet, passphrase)).toBe(false);
  });
});

describe("assertCosignOnlyAddedSignature", () => {
  const signed = mediatedPair(EXCHANGE_DESTINATION);

  test("accepts an envelope with one more signature and the same body", () => {
    expect(() =>
      assertCosignOnlyAddedSignature(signed, addSignature(signed, mediator), passphrase)
    ).not.toThrow();
  });

  test("refuses a changed body", () => {
    const tampered = addSignature(mediatedPair(Keypair.random().publicKey()), mediator);
    expect(() => assertCosignOnlyAddedSignature(signed, tampered, passphrase)).toThrow(
      "does not match"
    );
  });

  test("refuses an envelope with no new signature", () => {
    expect(() => assertCosignOnlyAddedSignature(signed, signed, passphrase)).toThrow(
      "did not add its signature"
    );
  });

  test("refuses an envelope that swapped the user's signature for others", () => {
    const tx = TransactionBuilder.fromXdr(signed, passphrase);
    tx.signatures.splice(0, tx.signatures.length);
    tx.sign(mediator);
    tx.sign(Keypair.random());
    expect(() =>
      assertCosignOnlyAddedSignature(signed, tx.toEnvelope().toXdr("base64"), passphrase)
    ).toThrow("dropped a signature");
  });
});

describe("cosignMerge", () => {
  const deps = (sign: (xdr: string) => Promise<string>) => ({
    destination: EXCHANGE_DESTINATION,
    networkPassphrase: passphrase,
    mediatorSign: mock(sign),
  });

  test("co-signs the merge and returns the co-signed envelope", async () => {
    const d = deps(async (x) => addSignature(x, mediator));
    const signed = mediatedPair(EXCHANGE_DESTINATION);
    const out = await cosignMerge(d)(anyTx, signed);
    expect(d.mediatorSign).toHaveBeenCalledTimes(1);
    expect(TransactionBuilder.fromXdr(out, passphrase).signatures).toHaveLength(2);
  });

  test("passes a cleanup transaction through without asking", async () => {
    const d = deps(async (x) => addSignature(x, mediator));
    const signed = cleanup();
    expect(await cosignMerge(d)(anyTx, signed)).toBe(signed);
    expect(d.mediatorSign).not.toHaveBeenCalled();
  });

  test("refuses a co-signature that changed the transaction", async () => {
    const d = deps(async () => addSignature(mediatedPair(wallet), mediator));
    await expect(cosignMerge(d)(anyTx, mediatedPair(EXCHANGE_DESTINATION))).rejects.toThrow(
      "does not match"
    );
  });

  test("refuses a co-signature that added nothing", async () => {
    const d = deps(async (x) => x);
    await expect(cosignMerge(d)(anyTx, mediatedPair(EXCHANGE_DESTINATION))).rejects.toThrow(
      "did not add its signature"
    );
  });
});

describe("verifyCloseTransaction on an exchange close", () => {
  const vector = vectors.vectors.find((v) => v.name === "exchange-close-through-intermediary")!;
  const { input } = vector;
  const account = {
    address: input.expected.source,
    nativeBalanceLumens: input.expected.nativeBalance,
    signers: input.expected.accountSigners,
    thresholds: input.expected.accountThresholds,
    trustlines: [],
    defiPositions: { positions: [] },
  } as unknown as AccountState;
  const tx = { xdr: input.unsignedXdr } as CloseTransaction;
  const memo = { value: "deposit-1", type: "text" } as const;

  function atVectorTime<T>(run: () => T): T {
    setSystemTime(new Date(vector.nowSeconds * 1000));
    try {
      return run();
    } finally {
      setSystemTime();
    }
  }

  test("accepts the intermediary pair with the typed destination and memo", () => {
    atVectorTime(() =>
      verifyCloseTransaction(tx, {
        account,
        destination: input.expected.destination,
        network: "testnet",
        memo,
      })
    );
  });

  test("refuses it for another typed destination", () => {
    expect(() =>
      atVectorTime(() =>
        verifyCloseTransaction(tx, { account, destination: wallet, network: "testnet", memo })
      )
    ).toThrow(VerificationError);
  });

  test("refuses it with another memo or none", () => {
    for (const m of [{ value: "deposit-2", type: "text" } as const, undefined]) {
      expect(() =>
        atVectorTime(() =>
          verifyCloseTransaction(tx, {
            account,
            destination: input.expected.destination,
            network: "testnet",
            memo: m,
          })
        )
      ).toThrow(VerificationError);
    }
  });
});
