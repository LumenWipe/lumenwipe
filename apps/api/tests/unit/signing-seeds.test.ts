import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Test } from "@nestjs/testing";
import { HttpException, Logger } from "@nestjs/common";
import {
  Account,
  Asset,
  Keypair,
  Memo,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { getMediatorKeypair } from "@/lib/stellar/mediator-server";
import { getFeeAccountKeypair } from "@/lib/stellar/fee-account";
import { MediatorController } from "@/mediator/mediator.controller";
import { MediatorSigningService } from "@/mediator/mediator-signing.service";
import { servedRegistry } from "@/lib/exchange-registry";
import {
  ACCOUNT_READER,
  CLOCK,
  EXCHANGE_REGISTRY,
  MEDIATOR_KEY_PROVIDER,
  defaultClock,
  defaultExchangeRegistry,
  defaultMediatorKeyProvider,
  type AccountReaderPort,
  type MediatorKeyProvider,
} from "@/common/ports";

const VARIABLES = ["MEDIATOR_SECRET_TESTNET", "FEE_ACCOUNT_SECRET_TESTNET"] as const;
const SAVED = Object.fromEntries(VARIABLES.map((v) => [v, process.env[v]]));

beforeEach(() => {
  for (const v of VARIABLES) delete process.env[v];
});

afterEach(() => {
  for (const v of VARIABLES) {
    const saved = SAVED[v];
    if (saved === undefined) delete process.env[v];
    else process.env[v] = saved;
  }
});

function invalidSeed(): string {
  return Keypair.random().secret().slice(0, -1);
}

const READERS = [
  {
    name: "mediator",
    variable: "MEDIATOR_SECRET_TESTNET",
    read: () => getMediatorKeypair("testnet"),
  },
  {
    name: "fee account",
    variable: "FEE_ACCOUNT_SECRET_TESTNET",
    read: () => getFeeAccountKeypair("testnet"),
  },
] as const;

for (const reader of READERS) {
  describe(`${reader.name} seed`, () => {
    test("a seed padded with whitespace and a trailing newline still loads", () => {
      const keypair = Keypair.random();
      process.env[reader.variable] = `  ${keypair.secret()}\n`;
      expect(reader.read()?.publicKey()).toBe(keypair.publicKey());
    });

    test("a whitespace-only value is treated as unset and logs nothing", () => {
      const error = spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
      try {
        process.env[reader.variable] = " \n\t";
        expect(reader.read()).toBeNull();
        expect(error).not.toHaveBeenCalled();
      } finally {
        error.mockRestore();
      }
    });

    test("an invalid seed is null and the log names the variable, never the value", () => {
      const error = spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
      try {
        const seed = invalidSeed();
        process.env[reader.variable] = seed;
        expect(reader.read()).toBeNull();
        expect(error).toHaveBeenCalledTimes(1);
        const logged = JSON.stringify(error.mock.calls);
        expect(logged).toContain(reader.variable);
        expect(logged).not.toContain(seed);
        expect(logged).not.toContain(seed.slice(1, 12));
      } finally {
        error.mockRestore();
      }
    });
  });
}

const USER = Keypair.random().publicKey();
const EXCHANGE = servedRegistry().entries[0]!.address;

async function makeController(): Promise<MediatorController> {
  const module = await Test.createTestingModule({
    controllers: [MediatorController],
    providers: [
      MediatorSigningService,
      {
        provide: MEDIATOR_KEY_PROVIDER,
        useValue: {
          keypair: defaultMediatorKeyProvider.keypair,
          configuredPublicKey: () => "",
        } satisfies MediatorKeyProvider,
      },
      { provide: EXCHANGE_REGISTRY, useValue: defaultExchangeRegistry },
      { provide: CLOCK, useValue: defaultClock },
      {
        provide: ACCOUNT_READER,
        useValue: {
          readNativeBalance: async () => ({ nativeBalanceLumens: "100.0000000" }),
          readMemoRequired: async () => false,
        } satisfies AccountReaderPort,
      },
    ],
  }).compile();
  return module.get(MediatorController);
}

function forwardXdr(mediator: string): string {
  return new TransactionBuilder(new Account(USER, "1"), {
    fee: "200",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.accountMerge({ destination: mediator }))
    .addOperation(
      Operation.payment({
        source: mediator,
        destination: EXCHANGE,
        asset: Asset.native(),
        amount: "50.0000000",
      })
    )
    .addMemo(Memo.text("deposit-4411"))
    .setTimeout(30)
    .build()
    .toXDR();
}

describe("mediator routes with the environment reader", () => {
  test("sign answers 503 mediator_not_configured for an invalid seed, not a 500", async () => {
    const error = spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    try {
      process.env.MEDIATOR_SECRET_TESTNET = invalidSeed();
      const controller = await makeController();
      const err = await controller
        .sign("testnet", { transaction: forwardXdr(Keypair.random().publicKey()) })
        .then(
          () => null,
          (e: unknown) => e
        );
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(503);
      expect((err as HttpException).getResponse()).toEqual({
        error: {
          code: "mediator_not_configured",
          message: "Exchange (mediator) flow is not configured on this server.",
        },
      });
    } finally {
      error.mockRestore();
    }
  });

  test("check reports available false for an invalid seed, not a 500", async () => {
    const error = spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    try {
      process.env.MEDIATOR_SECRET_TESTNET = invalidSeed();
      const controller = await makeController();
      expect((await controller.check("testnet", EXCHANGE)).available).toBe(false);
    } finally {
      error.mockRestore();
    }
  });

  test("a padded seed signs and is reported available", async () => {
    const mediator = Keypair.random();
    process.env.MEDIATOR_SECRET_TESTNET = `${mediator.secret()}\n`;
    const controller = await makeController();
    expect((await controller.check("testnet", EXCHANGE)).available).toBe(true);
    const out = await controller.sign("testnet", { transaction: forwardXdr(mediator.publicKey()) });
    const signed = new Transaction(out.transaction, Networks.TESTNET);
    expect(signed.signatures).toHaveLength(1);
    expect(mediator.verify(signed.hash(), signed.signatures[0]!.signature)).toBe(true);
  });
});
