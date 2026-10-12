import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { HttpException } from "@nestjs/common";
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { MediatorController } from "@/mediator/mediator.controller";
import { servedRegistry } from "@/lib/exchange-registry";
import { AccountNotFoundError } from "@/lib/utils/errors";
import * as networksModule from "@/config/networks";
import * as mediatorServerModule from "@/lib/stellar/mediator-server";
import * as accountStateModule from "@/lib/stellar/account-state";

const MEDIATOR = Keypair.random();
const USER = Keypair.random().publicKey();
const EXCHANGE = servedRegistry().entries[0]!.address;
const OTHER = Keypair.random().publicKey();

interface Fakes {
  keypair: Keypair | null;
  configuredPublic: string;
  balance: string | Error;
}

const DEFAULTS: Fakes = { keypair: MEDIATOR, configuredPublic: "", balance: "100.0000000" };

function makeController(overrides: Partial<Fakes> = {}): {
  controller: MediatorController;
  balanceReads: string[];
} {
  const fakes = { ...DEFAULTS, ...overrides };
  const balanceReads: string[] = [];
  spyOn(mediatorServerModule, "getMediatorKeypair").mockReturnValue(fakes.keypair);
  spyOn(networksModule, "getMediatorPublicKey").mockReturnValue(fakes.configuredPublic);
  spyOn(accountStateModule, "readNativeBalance").mockImplementation(async (address) => {
    balanceReads.push(address);
    if (fakes.balance instanceof Error) throw fakes.balance;
    return { nativeBalanceLumens: fakes.balance };
  });
  return { controller: new MediatorController(), balanceReads };
}

afterEach(() => {
  spyOn(mediatorServerModule, "getMediatorKeypair").mockRestore();
  spyOn(networksModule, "getMediatorPublicKey").mockRestore();
  spyOn(accountStateModule, "readNativeBalance").mockRestore();
});

interface TxOptions {
  ops?: xdr.Operation[];
  source?: string;
  fee?: string;
}

function merge(destination: string, source?: string) {
  return Operation.accountMerge({ destination, ...(source ? { source } : {}) });
}

function pay(opts: { source?: string; destination?: string; asset?: Asset; amount?: string }) {
  return Operation.payment({
    source: opts.source ?? MEDIATOR.publicKey(),
    destination: opts.destination ?? EXCHANGE,
    asset: opts.asset ?? Asset.native(),
    amount: opts.amount ?? "50.0000000",
  });
}

function buildXdr(opts: TxOptions = {}): string {
  const builder = new TransactionBuilder(new Account(opts.source ?? USER, "1"), {
    fee: opts.fee ?? "200",
    networkPassphrase: Networks.TESTNET,
  });
  for (const op of opts.ops ?? [merge(MEDIATOR.publicKey()), pay({})]) builder.addOperation(op);
  return builder.setTimeout(30).build().toXDR();
}

async function expectFail(
  promise: Promise<unknown>,
  status: number,
  code: string,
  message: string
) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(HttpException);
  const e = err as HttpException;
  expect(e.getStatus()).toBe(status);
  expect(e.getResponse()).toEqual({ error: { code, message } });
}

const NOT_ALLOWED = [
  "transaction_structure_not_allowed",
  "Transaction structure not allowed",
] as const;

describe("sign: configuration gates", () => {
  test("S1 an unconfigured mediator is refused with 503", async () => {
    const { controller } = makeController({ keypair: null });
    await expectFail(
      controller.sign("testnet", { transaction: buildXdr() }),
      503,
      "mediator_not_configured",
      "Exchange (mediator) flow is not configured on this server."
    );
  });

  test("S2 a configured public key that differs from the secret's is refused with 500", async () => {
    const { controller } = makeController({ configuredPublic: Keypair.random().publicKey() });
    await expectFail(
      controller.sign("testnet", { transaction: buildXdr() }),
      500,
      "mediator_key_misconfiguration",
      "Mediator key misconfiguration"
    );
  });

  test("S2b a configured public key that matches the secret's is accepted", async () => {
    const { controller } = makeController({ configuredPublic: MEDIATOR.publicKey() });
    const out = await controller.sign("testnet", { transaction: buildXdr() });
    expect(typeof out.transaction).toBe("string");
  });
});

describe("sign: body gates", () => {
  test("S3 a missing body is refused", async () => {
    const { controller } = makeController();
    await expectFail(
      controller.sign("testnet", undefined as unknown as { transaction?: string }),
      400,
      "missing_transaction",
      "Missing transaction"
    );
  });

  test("S3b an empty transaction is refused", async () => {
    const { controller } = makeController();
    await expectFail(
      controller.sign("testnet", { transaction: "" }),
      400,
      "missing_transaction",
      "Missing transaction"
    );
  });

  test("S4 an undecodable envelope is refused", async () => {
    const { controller } = makeController();
    await expectFail(
      controller.sign("testnet", { transaction: "not-xdr" }),
      400,
      "invalid_transaction_xdr",
      "Invalid transaction XDR"
    );
  });
});

describe("sign: structure", () => {
  test("S5a a single operation is refused", async () => {
    const { controller } = makeController();
    const transaction = buildXdr({ ops: [merge(MEDIATOR.publicKey())] });
    await expectFail(controller.sign("testnet", { transaction }), 400, ...NOT_ALLOWED);
  });

  test("S5b three operations are refused", async () => {
    const { controller } = makeController();
    const transaction = buildXdr({ ops: [merge(MEDIATOR.publicKey()), pay({}), pay({})] });
    await expectFail(controller.sign("testnet", { transaction }), 400, ...NOT_ALLOWED);
  });

  test("S5c a first operation that is not an account merge is refused", async () => {
    const { controller } = makeController();
    const transaction = buildXdr({ ops: [pay({ source: USER }), pay({})] });
    await expectFail(controller.sign("testnet", { transaction }), 400, ...NOT_ALLOWED);
  });

  test("S5d a second operation that is not a payment is refused", async () => {
    const { controller } = makeController();
    const transaction = buildXdr({ ops: [merge(MEDIATOR.publicKey()), merge(EXCHANGE)] });
    await expectFail(controller.sign("testnet", { transaction }), 400, ...NOT_ALLOWED);
  });

  test("S6a a merge sourced from the mediator is refused", async () => {
    const { controller } = makeController();
    const transaction = buildXdr({
      ops: [merge(MEDIATOR.publicKey(), MEDIATOR.publicKey()), pay({})],
    });
    await expectFail(controller.sign("testnet", { transaction }), 400, ...NOT_ALLOWED);
  });

  test("S6b a merge into anything other than the mediator is refused", async () => {
    const { controller } = makeController();
    const transaction = buildXdr({ ops: [merge(OTHER), pay({})] });
    await expectFail(controller.sign("testnet", { transaction }), 400, ...NOT_ALLOWED);
  });

  test("S6c a payment not sourced from the mediator is refused", async () => {
    const { controller } = makeController();
    const transaction = buildXdr({ ops: [merge(MEDIATOR.publicKey()), pay({ source: OTHER })] });
    await expectFail(controller.sign("testnet", { transaction }), 400, ...NOT_ALLOWED);
  });

  test("S6d a payment back to the mediator is refused", async () => {
    const { controller } = makeController();
    const transaction = buildXdr({
      ops: [merge(MEDIATOR.publicKey()), pay({ destination: MEDIATOR.publicKey() })],
    });
    await expectFail(controller.sign("testnet", { transaction }), 400, ...NOT_ALLOWED);
  });

  test("S6e a non-native payment is refused", async () => {
    const { controller } = makeController();
    const transaction = buildXdr({
      ops: [merge(MEDIATOR.publicKey()), pay({ asset: new Asset("USDC", OTHER) })],
    });
    await expectFail(controller.sign("testnet", { transaction }), 400, ...NOT_ALLOWED);
  });

  test("S6f a forward below 1 XLM is refused", async () => {
    const { controller } = makeController();
    const transaction = buildXdr({
      ops: [merge(MEDIATOR.publicKey()), pay({ amount: "0.9999999" })],
    });
    await expectFail(controller.sign("testnet", { transaction }), 400, ...NOT_ALLOWED);
  });

  test("S6g a forward of exactly 1 XLM is accepted", async () => {
    const { controller } = makeController();
    const transaction = buildXdr({
      ops: [merge(MEDIATOR.publicKey()), pay({ amount: "1.0000000" })],
    });
    const out = await controller.sign("testnet", { transaction });
    expect(typeof out.transaction).toBe("string");
  });
});

describe("sign: source rules", () => {
  test("S7a a transaction sourced from the mediator is refused", async () => {
    const { controller } = makeController();
    const transaction = buildXdr({
      source: MEDIATOR.publicKey(),
      ops: [merge(MEDIATOR.publicKey(), USER), pay({})],
    });
    await expectFail(controller.sign("testnet", { transaction }), 400, ...NOT_ALLOWED);
  });

  test("S7b a merge without its own source on a mediator-sourced transaction is refused", async () => {
    const { controller } = makeController();
    const transaction = buildXdr({ source: MEDIATOR.publicKey() });
    await expectFail(controller.sign("testnet", { transaction }), 400, ...NOT_ALLOWED);
  });

  test("S7c a merged source that is not a plain G address is refused", async () => {
    const { controller, balanceReads } = makeController();
    const muxed = "MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAJLK";
    const transaction = buildXdr({ ops: [merge(MEDIATOR.publicKey(), muxed), pay({})] });
    await expectFail(controller.sign("testnet", { transaction }), 400, ...NOT_ALLOWED);
    expect(balanceReads).toEqual([]);
  });
});

describe("sign: balance bound", () => {
  test("S8 an unknown merged account is refused", async () => {
    const { controller } = makeController({ balance: new AccountNotFoundError(USER) });
    await expectFail(
      controller.sign("testnet", { transaction: buildXdr() }),
      400,
      "merged_account_not_found",
      "Merged account not found"
    );
  });

  test("S8b a failed balance read is rethrown, never co-signed", async () => {
    const { controller } = makeController({ balance: new Error("horizon down") });
    await expect(controller.sign("testnet", { transaction: buildXdr() })).rejects.toThrow(
      "horizon down"
    );
  });

  test("S9 a forward above the merged balance is refused", async () => {
    const { controller } = makeController({ balance: "10.0000000" });
    await expectFail(
      controller.sign("testnet", { transaction: buildXdr() }),
      400,
      "forward_amount_exceeds_balance",
      "Forward amount exceeds the merged balance"
    );
  });

  test("S9b a forward equal to the balance minus the transaction fee is accepted", async () => {
    const { controller } = makeController({ balance: "50.0000400" });
    const out = await controller.sign("testnet", { transaction: buildXdr() });
    expect(typeof out.transaction).toBe("string");
  });
});

describe("sign: success", () => {
  test("S10 co-signs with the mediator key and changes nothing else", async () => {
    const original = buildXdr();
    const { controller, balanceReads } = makeController();
    const out = await controller.sign("testnet", { transaction: original });
    const before = new Transaction(original, Networks.TESTNET);
    const after = new Transaction(out.transaction, Networks.TESTNET);
    expect(balanceReads).toEqual([USER]);
    expect(after.signatures).toHaveLength(1);
    expect(MEDIATOR.verify(after.hash(), after.signatures[0]!.signature())).toBe(true);
    expect(after.hash()).toEqual(before.hash());
    expect(after.operations).toEqual(before.operations);
  });

  test("S10b the balance is read from the merge's own source when it has one", async () => {
    const { controller, balanceReads } = makeController();
    const transaction = buildXdr({ ops: [merge(MEDIATOR.publicKey(), OTHER), pay({})] });
    await controller.sign("testnet", { transaction });
    expect(balanceReads).toEqual([OTHER]);
  });
});

describe("check", () => {
  test("C1 a listed exchange reports the mediator and memo requirements", async () => {
    const entry = servedRegistry().entries[0]!;
    const { controller, balanceReads } = makeController();
    const result = await controller.check("testnet", entry.address);
    expect(result).toEqual({
      requiresMediator: entry.requiresMediator,
      reason: `${entry.name} does not support direct account merges.`,
      requiresMemo: entry.requiresMemo,
      memoType: entry.memoType,
      exchangeName: entry.name,
      available: true,
      registryFresh: true,
    });
    expect(balanceReads).toEqual([]);
  });

  test("C2 an unlisted existing address supports direct merges", async () => {
    const { controller, balanceReads } = makeController();
    expect(await controller.check("testnet", OTHER)).toEqual({
      requiresMediator: false,
      reason: "Destination account exists and supports account merges.",
      requiresMemo: false,
      memoType: null,
      exchangeName: null,
      available: true,
      registryFresh: true,
    });
    expect(balanceReads).toEqual([OTHER]);
  });

  test("C3 an unlisted missing address is reported as to-be-created", async () => {
    const { controller } = makeController({ balance: new AccountNotFoundError(OTHER) });
    expect(await controller.check("testnet", OTHER)).toEqual({
      requiresMediator: false,
      reason: "Destination account does not exist yet. Merging into it will create it.",
      requiresMemo: false,
      memoType: null,
      exchangeName: null,
      available: true,
      registryFresh: true,
    });
  });

  test("C4 an unexpected read failure is rethrown", async () => {
    const { controller } = makeController({ balance: new Error("horizon down") });
    await expect(controller.check("testnet", OTHER)).rejects.toThrow("horizon down");
  });

  test("C5 an unconfigured mediator reports available false on every path", async () => {
    const entry = servedRegistry().entries[0]!;
    const { controller } = makeController({ keypair: null });
    expect((await controller.check("testnet", entry.address)).available).toBe(false);
    expect((await controller.check("testnet", OTHER)).available).toBe(false);
  });
});
