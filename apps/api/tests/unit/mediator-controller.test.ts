import { describe, expect, test } from "bun:test";
import { Test } from "@nestjs/testing";
import { HttpException } from "@nestjs/common";
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
import { MediatorController } from "@/mediator/mediator.controller";
import { servedRegistry } from "@/lib/exchange-registry";
import { AccountNotFoundError } from "@/lib/utils/errors";
import { LiveReadError } from "@/lib/stellar/live-trustline";
import { MediatorSigningService } from "@/mediator/mediator-signing.service";
import {
  ACCOUNT_READER,
  CLOCK,
  EXCHANGE_REGISTRY,
  MEDIATOR_KEY_PROVIDER,
  defaultClock,
  defaultExchangeRegistry,
  type AccountReaderPort,
  type MediatorKeyProvider,
} from "@/common/ports";

const MEDIATOR = Keypair.random();
const USER = Keypair.random().publicKey();
const EXCHANGE = servedRegistry().entries[0]!.address;
const OTHER = Keypair.random().publicKey();
const ID_EXCHANGE = servedRegistry().entries.find((e) => e.memoType === "id")!.address;

interface Fakes {
  keypair: Keypair | null;
  configuredPublic: string;
  balance: string | Error;
  memoRequired: boolean | Error;
}

const DEFAULTS: Fakes = {
  keypair: MEDIATOR,
  configuredPublic: "",
  balance: "100.0000000",
  memoRequired: false,
};

async function makeController(overrides: Partial<Fakes> = {}): Promise<{
  controller: MediatorController;
  balanceReads: string[];
  memoReads: string[];
}> {
  const fakes = { ...DEFAULTS, ...overrides };
  const balanceReads: string[] = [];
  const memoReads: string[] = [];
  const module = await Test.createTestingModule({
    controllers: [MediatorController],
    providers: [
      MediatorSigningService,
      {
        provide: MEDIATOR_KEY_PROVIDER,
        useValue: {
          keypair: () => fakes.keypair,
          configuredPublicKey: () => fakes.configuredPublic,
        } satisfies MediatorKeyProvider,
      },
      { provide: EXCHANGE_REGISTRY, useValue: defaultExchangeRegistry },
      { provide: CLOCK, useValue: defaultClock },
      {
        provide: ACCOUNT_READER,
        useValue: {
          readNativeBalance: async (address: string) => {
            balanceReads.push(address);
            if (fakes.balance instanceof Error) throw fakes.balance;
            return { nativeBalanceLumens: fakes.balance };
          },
          readMemoRequired: async (address: string) => {
            memoReads.push(address);
            if (fakes.memoRequired instanceof Error) throw fakes.memoRequired;
            return fakes.memoRequired;
          },
        } satisfies AccountReaderPort,
      },
    ],
  }).compile();
  return { controller: module.get(MediatorController), balanceReads, memoReads };
}

interface TxOptions {
  ops?: xdr.Operation[];
  source?: string;
  fee?: string;
  memo?: Memo;
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
  builder.addMemo(opts.memo ?? Memo.text("deposit-4411"));
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
    const { controller } = await makeController({ keypair: null });
    await expectFail(
      controller.sign("testnet", { transaction: buildXdr() }),
      503,
      "mediator_not_configured",
      "Exchange (mediator) flow is not configured on this server."
    );
  });

  test("S2 a configured public key that differs from the secret's is refused with 500", async () => {
    const { controller } = await makeController({ configuredPublic: Keypair.random().publicKey() });
    await expectFail(
      controller.sign("testnet", { transaction: buildXdr() }),
      500,
      "mediator_key_misconfiguration",
      "Mediator key misconfiguration"
    );
  });

  test("S2b a configured public key that matches the secret's is accepted", async () => {
    const { controller } = await makeController({ configuredPublic: MEDIATOR.publicKey() });
    const out = await controller.sign("testnet", { transaction: buildXdr() });
    expect(typeof out.transaction).toBe("string");
  });
});

describe("sign: body gates", () => {
  test("S3 a missing body is refused", async () => {
    const { controller } = await makeController();
    await expectFail(
      controller.sign("testnet", undefined as unknown as { transaction?: string }),
      400,
      "missing_transaction",
      "Missing transaction"
    );
  });

  test("S3b an empty transaction is refused", async () => {
    const { controller } = await makeController();
    await expectFail(
      controller.sign("testnet", { transaction: "" }),
      400,
      "missing_transaction",
      "Missing transaction"
    );
  });

  test("S4 an undecodable envelope is refused", async () => {
    const { controller } = await makeController();
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
    const { controller } = await makeController();
    const transaction = buildXdr({ ops: [merge(MEDIATOR.publicKey())] });
    await expectFail(controller.sign("testnet", { transaction }), 400, ...NOT_ALLOWED);
  });

  test("S5b three operations are refused", async () => {
    const { controller } = await makeController();
    const transaction = buildXdr({ ops: [merge(MEDIATOR.publicKey()), pay({}), pay({})] });
    await expectFail(controller.sign("testnet", { transaction }), 400, ...NOT_ALLOWED);
  });

  test("S5c a first operation that is not an account merge is refused", async () => {
    const { controller } = await makeController();
    const transaction = buildXdr({ ops: [pay({ source: USER }), pay({})] });
    await expectFail(controller.sign("testnet", { transaction }), 400, ...NOT_ALLOWED);
  });

  test("S5d a second operation that is not a payment is refused", async () => {
    const { controller } = await makeController();
    const transaction = buildXdr({
      ops: [merge(MEDIATOR.publicKey()), merge(EXCHANGE, MEDIATOR.publicKey())],
    });
    await expectFail(controller.sign("testnet", { transaction }), 400, ...NOT_ALLOWED);
  });

  test("S6a a merge sourced from the mediator is refused", async () => {
    const { controller } = await makeController();
    const transaction = buildXdr({
      ops: [merge(MEDIATOR.publicKey(), MEDIATOR.publicKey()), pay({})],
    });
    await expectFail(controller.sign("testnet", { transaction }), 400, ...NOT_ALLOWED);
  });

  test("S6b a merge into anything other than the mediator is refused", async () => {
    const { controller } = await makeController();
    const transaction = buildXdr({ ops: [merge(OTHER), pay({})] });
    await expectFail(controller.sign("testnet", { transaction }), 400, ...NOT_ALLOWED);
  });

  test("S6c a payment not sourced from the mediator is refused", async () => {
    const { controller } = await makeController();
    const transaction = buildXdr({ ops: [merge(MEDIATOR.publicKey()), pay({ source: OTHER })] });
    await expectFail(controller.sign("testnet", { transaction }), 400, ...NOT_ALLOWED);
  });

  test("S6d a payment back to the mediator is refused", async () => {
    const { controller } = await makeController();
    const transaction = buildXdr({
      ops: [merge(MEDIATOR.publicKey()), pay({ destination: MEDIATOR.publicKey() })],
    });
    await expectFail(controller.sign("testnet", { transaction }), 400, ...NOT_ALLOWED);
  });

  test("S6e a non-native payment is refused", async () => {
    const { controller } = await makeController();
    const transaction = buildXdr({
      ops: [merge(MEDIATOR.publicKey()), pay({ asset: new Asset("USDC", OTHER) })],
    });
    await expectFail(controller.sign("testnet", { transaction }), 400, ...NOT_ALLOWED);
  });

  test("S6f a forward below 1 XLM is refused", async () => {
    const { controller } = await makeController();
    const transaction = buildXdr({
      ops: [merge(MEDIATOR.publicKey()), pay({ amount: "0.9999999" })],
    });
    await expectFail(controller.sign("testnet", { transaction }), 400, ...NOT_ALLOWED);
  });

  test("S6g a forward of exactly 1 XLM is accepted", async () => {
    const { controller } = await makeController();
    const transaction = buildXdr({
      ops: [merge(MEDIATOR.publicKey()), pay({ amount: "1.0000000" })],
    });
    const out = await controller.sign("testnet", { transaction });
    expect(typeof out.transaction).toBe("string");
  });
});

describe("sign: source rules", () => {
  test("S7a a transaction sourced from the mediator is refused", async () => {
    const { controller } = await makeController();
    const transaction = buildXdr({
      source: MEDIATOR.publicKey(),
      ops: [merge(MEDIATOR.publicKey(), USER), pay({})],
    });
    await expectFail(controller.sign("testnet", { transaction }), 400, ...NOT_ALLOWED);
  });

  test("S7b a merge without its own source on a mediator-sourced transaction is refused", async () => {
    const { controller } = await makeController();
    const transaction = buildXdr({ source: MEDIATOR.publicKey() });
    await expectFail(controller.sign("testnet", { transaction }), 400, ...NOT_ALLOWED);
  });

  test("S7c a merged source that is not a plain G address is refused", async () => {
    const { controller, balanceReads } = await makeController();
    const muxed = "MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAJLK";
    const transaction = buildXdr({ ops: [merge(MEDIATOR.publicKey(), muxed), pay({})] });
    await expectFail(controller.sign("testnet", { transaction }), 400, ...NOT_ALLOWED);
    expect(balanceReads).toEqual([]);
  });
});

describe("sign: balance bound", () => {
  test("S8 an unknown merged account is refused", async () => {
    const { controller } = await makeController({ balance: new AccountNotFoundError(USER) });
    await expectFail(
      controller.sign("testnet", { transaction: buildXdr() }),
      400,
      "merged_account_not_found",
      "Merged account not found"
    );
  });

  test("S8b a failed balance read is rethrown, never co-signed", async () => {
    const { controller } = await makeController({ balance: new Error("horizon down") });
    await expect(controller.sign("testnet", { transaction: buildXdr() })).rejects.toThrow(
      "horizon down"
    );
  });

  test("S9 a forward above the merged balance is refused", async () => {
    const { controller } = await makeController({ balance: "10.0000000" });
    await expectFail(
      controller.sign("testnet", { transaction: buildXdr() }),
      400,
      "forward_amount_exceeds_balance",
      "Forward amount exceeds the merged balance"
    );
  });

  test("S9c a forward one stroop above the balance minus the transaction fee is refused", async () => {
    const { controller } = await makeController({ balance: "50.0000399" });
    await expectFail(
      controller.sign("testnet", { transaction: buildXdr() }),
      400,
      "forward_amount_exceeds_balance",
      "Forward amount exceeds the merged balance"
    );
  });

  test("S9b a forward equal to the balance minus the transaction fee is accepted", async () => {
    const { controller } = await makeController({ balance: "50.0000400" });
    const out = await controller.sign("testnet", { transaction: buildXdr() });
    expect(typeof out.transaction).toBe("string");
  });
});

describe("sign: success", () => {
  test("S10 co-signs with the mediator key and changes nothing else", async () => {
    const original = buildXdr();
    const { controller, balanceReads } = await makeController();
    const out = await controller.sign("testnet", { transaction: original });
    const before = new Transaction(original, Networks.TESTNET);
    const after = new Transaction(out.transaction, Networks.TESTNET);
    expect(balanceReads).toEqual([USER]);
    expect(after.signatures).toHaveLength(1);
    expect(MEDIATOR.verify(after.hash(), after.signatures[0]!.signature)).toBe(true);
    expect(after.hash()).toEqual(before.hash());
    expect(after.operations).toEqual(before.operations);
  });

  test("S10b the balance is read from the merge's own source when it has one", async () => {
    const { controller, balanceReads } = await makeController();
    const transaction = buildXdr({ ops: [merge(MEDIATOR.publicKey(), OTHER), pay({})] });
    await controller.sign("testnet", { transaction });
    expect(balanceReads).toEqual([OTHER]);
  });
});

describe("sign: memo rules", () => {
  const forwardTo = (destination: string, memo: Memo) =>
    buildXdr({ ops: [merge(MEDIATOR.publicKey()), pay({ destination })], memo });

  async function expectMemoFail(transaction: string, code: string, fakes: Partial<Fakes> = {}) {
    const { controller } = await makeController(fakes);
    const err = await controller.sign("testnet", { transaction }).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(422);
    expect(((err as HttpException).getResponse() as { error: { code: string } }).error.code).toBe(
      code
    );
  }

  test("S11a a forward to a listed exchange without a memo is not co-signed", async () => {
    await expectMemoFail(forwardTo(EXCHANGE, Memo.none()), "memo_required");
  });

  test("S11b an empty text memo counts as no memo", async () => {
    await expectMemoFail(forwardTo(EXCHANGE, Memo.text("")), "memo_required");
  });

  test("S11c a memo of the wrong type for a listed exchange is not co-signed", async () => {
    await expectMemoFail(forwardTo(EXCHANGE, Memo.id("4411")), "invalid_memo");
    await expectMemoFail(forwardTo(ID_EXCHANGE, Memo.text("4411")), "invalid_memo");
  });

  test("S11d a hash memo is not co-signed", async () => {
    await expectMemoFail(forwardTo(EXCHANGE, Memo.hash("a".repeat(64))), "unsupported_memo_type");
  });

  test("S11e a forward to a listed exchange with its memo type is co-signed without a ledger read", async () => {
    const { controller, memoReads } = await makeController({ memoRequired: new Error("unused") });
    const out = await controller.sign("testnet", {
      transaction: forwardTo(ID_EXCHANGE, Memo.id("4411")),
    });
    expect(typeof out.transaction).toBe("string");
    expect(memoReads).toEqual([]);
  });

  test("S12a a forward to an account that requires a memo on-chain needs one", async () => {
    await expectMemoFail(forwardTo(OTHER, Memo.none()), "memo_required", { memoRequired: true });
    await expectMemoFail(forwardTo(OTHER, Memo.hash("a".repeat(64))), "unsupported_memo_type", {
      memoRequired: true,
    });
  });

  test("S12b a forward that carries a text or id memo is co-signed without a ledger read", async () => {
    const { controller, memoReads } = await makeController({ memoRequired: true });
    for (const memo of [Memo.text("4411"), Memo.id("4411")]) {
      const out = await controller.sign("testnet", { transaction: forwardTo(OTHER, memo) });
      expect(typeof out.transaction).toBe("string");
    }
    expect(memoReads).toEqual([]);
  });

  test("S12e a blank text memo does not satisfy a memo requirement", async () => {
    await expectMemoFail(forwardTo(EXCHANGE, Memo.text("  ")), "memo_required");
    await expectMemoFail(forwardTo(OTHER, Memo.text(" ")), "memo_required", { memoRequired: true });
  });

  test("S12f a forward to a muxed destination is refused before any ledger read", async () => {
    const { controller, memoReads, balanceReads } = await makeController();
    const muxed = "MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAJLK";
    const transaction = forwardTo(muxed, Memo.text("4411"));
    await expectFail(controller.sign("testnet", { transaction }), 400, ...NOT_ALLOWED);
    expect(memoReads).toEqual([]);
    expect(balanceReads).toEqual([]);
  });

  test("S12c a forward to an account with no memo requirement needs no memo", async () => {
    const { controller } = await makeController();
    const out = await controller.sign("testnet", { transaction: forwardTo(OTHER, Memo.none()) });
    expect(typeof out.transaction).toBe("string");
  });

  test("S12d an unreadable memo requirement is never co-signed", async () => {
    const { controller, balanceReads } = await makeController({
      memoRequired: new LiveReadError("The destination's memo requirement"),
    });
    await expectFail(
      controller.sign("testnet", { transaction: forwardTo(OTHER, Memo.none()) }),
      503,
      "service_unavailable",
      "The destination's memo requirement could not be read from the network. Retry in a moment."
    );
    expect(balanceReads).toEqual([]);
  });
});

describe("check", () => {
  test("C1 a listed exchange reports the mediator and memo requirements", async () => {
    const entry = servedRegistry().entries[0]!;
    const { controller, balanceReads } = await makeController();
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
    const { controller, balanceReads } = await makeController();
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
    const { controller } = await makeController({ balance: new AccountNotFoundError(OTHER) });
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

  test("C2b an unlisted address that requires a memo on-chain reports it", async () => {
    const { controller, memoReads } = await makeController({ memoRequired: true });
    expect(await controller.check("testnet", OTHER)).toEqual({
      requiresMediator: false,
      reason: "Destination account exists and states that payments to it need a memo.",
      requiresMemo: true,
      memoType: "text",
      exchangeName: null,
      available: true,
      registryFresh: true,
    });
    expect(memoReads).toEqual([OTHER]);
  });

  test("C4 an unexpected read failure is rethrown", async () => {
    const { controller } = await makeController({ balance: new Error("horizon down") });
    await expect(controller.check("testnet", OTHER)).rejects.toThrow("horizon down");
  });

  test("C5 an unconfigured mediator reports available false on every path", async () => {
    const entry = servedRegistry().entries[0]!;
    const { controller } = await makeController({ keypair: null });
    expect((await controller.check("testnet", entry.address)).available).toBe(false);
    expect((await controller.check("testnet", OTHER)).available).toBe(false);
  });
});
