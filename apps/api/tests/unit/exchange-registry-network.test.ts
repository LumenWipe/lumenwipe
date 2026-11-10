import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
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
} from "@stellar/stellar-sdk";
import type { AccountState, Trustline } from "@lumenwipe/types";
import * as registry from "@/lib/exchange-registry";
import * as networks from "@/config/networks";
import * as rpcModule from "@/lib/stellar/rpc";
import type { Network } from "@/config/networks";
import { ALL_ON } from "@/config/kill-switches";
import { buildCloseTransactions } from "@/lib/close-api/build-transactions";
import { memoRuleFor } from "@/lib/close-api/memo-rules";
import { MediatorSigningService } from "@/mediator/mediator-signing.service";
import { defaultClock, type ExchangeRegistryPort } from "@/common/ports";
import { mirrorSnapshot } from "./fixtures/ledger-trustlines";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";
import { stubIssuance } from "./fixtures/issuance";
import { stubLedgerConfirmation } from "./fixtures/ledger-confirmation";

const STAND_IN = Keypair.random().publicKey();
const EVERYWHERE = Keypair.random().publicKey();
const SOURCE = Keypair.random().publicKey();
const MEDIATOR = Keypair.random();
const MEMO = "4411";

const parsed = registry.parseRegistry({
  version: "2026-11-10",
  lastVerified: "2026-11-10",
  validUntil: "2027-02-08",
  source: "https://example.com",
  entries: [
    {
      address: STAND_IN,
      name: "Stand-in",
      domain: "stand-in.example",
      requiresMediator: true,
      requiresMemo: true,
      memoType: "id",
      network: "testnet",
    },
    {
      address: EVERYWHERE,
      name: "Everywhere",
      domain: "everywhere.example",
      requiresMediator: true,
      requiresMemo: true,
      memoType: "text",
    },
  ],
});
const lookups = registry.registryLookups(parsed.entries);

function fileWith(network: unknown): unknown {
  return {
    version: "2026-11-10",
    lastVerified: "2026-11-10",
    validUntil: "2027-02-08",
    source: "https://example.com",
    entries: [
      {
        address: STAND_IN,
        name: "Stand-in",
        domain: "stand-in.example",
        requiresMediator: true,
        requiresMemo: true,
        memoType: "id",
        network,
      },
    ],
  };
}

describe("parseRegistry network scope", () => {
  test("the served registry keeps a testnet-only entry's scope and adds none to an unscoped one", () => {
    const [scoped, everywhere] = registry.servedRegistry(parsed).entries;
    expect(scoped!.network).toBe("testnet");
    expect("network" in everywhere!).toBe(false);
  });

  test.each([["mainnet"], [""], [null], ["Testnet"], ["TESTNET"], [1], [true]])(
    "refuses network %p",
    (value) => {
      expect(() => registry.parseRegistry(fileWith(value))).toThrow(
        registry.RegistryValidationError
      );
      expect(() => registry.parseRegistry(fileWith(value))).toThrow(/unknown network/);
    }
  );
});

describe("lookups by network", () => {
  test("a testnet-only entry is recognized on testnet and needs its memo", () => {
    const entry = lookups.lookup(STAND_IN, "testnet");
    expect(entry?.name).toBe("Stand-in");
    expect(lookups.requiresMediator(STAND_IN, "testnet")).toBe(true);
    expect(memoRuleFor(entry, false)).toMatchObject({
      required: true,
      memoType: "id",
      fixedType: true,
      source: "registry",
    });
  });

  test("the same address is unknown on mainnet, with no relay and no memo rule", () => {
    const entry = lookups.lookup(STAND_IN, "mainnet");
    expect(entry).toBeNull();
    expect(lookups.requiresMediator(STAND_IN, "mainnet")).toBe(false);
    expect(memoRuleFor(entry, false)).toMatchObject({ required: false, fixedType: false });
  });

  test("an entry with no network applies on both", () => {
    expect(lookups.lookup(EVERYWHERE, "mainnet")?.name).toBe("Everywhere");
    expect(lookups.lookup(EVERYWHERE, "testnet")?.name).toBe("Everywhere");
  });
});

let snapshot: Trustline[] = [];

function state(network: Network): AccountState {
  const s: AccountState = {
    address: SOURCE,
    network,
    sequence: "100",
    nativeBalanceLumens: "50.0000000",
    dataEntries: [],
    signers: [{ key: SOURCE, weight: 1, type: "ed25519_public_key" }],
    thresholds: { low: 0, med: 1, high: 1 },
    numSubEntries: 0,
    numSponsoring: 0,
    sponsoredBy: null,
    authImmutable: false,
    trustlines: [],
    openOffers: [],
    poolShares: [],
    claimableBalances: [],
    subEntryMismatch: false,
    sponsoredEntries: [],
    sponsorshipEnumerationIncomplete: false,
    defiPositions: emptyDefiPositionsResult(SOURCE),
    defiPositionsWarnings: [],
  };
  snapshot = s.trustlines;
  return s;
}

const PASSPHRASE: Record<Network, string> = { mainnet: Networks.PUBLIC, testnet: Networks.TESTNET };

describe("close plan", () => {
  beforeEach(() => {
    stubIssuance();
    stubLedgerConfirmation();
    spyOn(rpcModule, "getRpcServer").mockImplementation((() => ({
      getAccount: () => Promise.resolve(new Account(SOURCE, "100")),
      getLatestLedger: () => Promise.resolve({ sequence: 1000 }),
      getLedgerEntries: mirrorSnapshot(SOURCE, () => snapshot),
    })) as unknown as typeof rpcModule.getRpcServer);
    spyOn(registry, "lookupExchange").mockImplementation(lookups.lookup);
    spyOn(registry, "requiresMediatorForAddress").mockImplementation(lookups.requiresMediator);
    spyOn(networks, "getMediatorPublicKey").mockReturnValue(MEDIATOR.publicKey());
  });

  afterEach(() => {
    mock.restore();
  });

  async function operationsOf(network: Network) {
    const built = await buildCloseTransactions(ALL_ON, state(network), STAND_IN, {}, network, MEMO);
    expect(built.transactions).toHaveLength(1);
    return new Transaction(built.transactions[0]!.xdr, PASSPHRASE[network]);
  }

  test("on testnet the stand-in gets the two-operation relay form with its id memo", async () => {
    const tx = await operationsOf("testnet");
    expect(tx.operations.map((o) => o.type)).toEqual(["accountMerge", "payment"]);
    expect(tx.source).toBe(SOURCE);
    expect(tx.operations[0]).toMatchObject({ destination: MEDIATOR.publicKey() });
    expect(tx.operations[1]).toMatchObject({
      source: MEDIATOR.publicKey(),
      destination: STAND_IN,
    });
    expect(tx.memo.type).toBe("id");
    expect(tx.memo.value).toBe(MEMO);
  });

  test("on mainnet the same address is a direct merge, never routed through the relay", async () => {
    const tx = await operationsOf("mainnet");
    expect(tx.operations.map((o) => o.type)).toEqual(["accountMerge"]);
    expect(tx.operations[0]).toMatchObject({ destination: STAND_IN });
  });
});

describe("mediator", () => {
  const port: ExchangeRegistryPort = {
    lookup: lookups.lookup,
    requiresMediator: lookups.requiresMediator,
    isFresh: () => true,
  };

  function service(): MediatorSigningService {
    return new MediatorSigningService(
      { keypair: () => MEDIATOR, configuredPublicKey: () => "" },
      port,
      defaultClock,
      {
        readNativeBalance: async () => ({ nativeBalanceLumens: "100.0000000" }) as never,
        readMemoRequired: async () => false,
      }
    );
  }

  function forward(network: Network, memo: Memo): string {
    return new TransactionBuilder(new Account(SOURCE, "1"), {
      fee: "200",
      networkPassphrase: PASSPHRASE[network],
    })
      .addOperation(Operation.accountMerge({ destination: MEDIATOR.publicKey() }))
      .addOperation(
        Operation.payment({
          source: MEDIATOR.publicKey(),
          destination: STAND_IN,
          asset: Asset.native(),
          amount: "50.0000000",
        })
      )
      .addMemo(memo)
      .setTimeout(30)
      .build()
      .toXDR();
  }

  async function refusal(promise: Promise<unknown>): Promise<unknown> {
    const err = await promise.then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(HttpException);
    return (err as HttpException).getResponse();
  }

  test("on testnet the relay check routes the stand-in through the relay with its memo type", async () => {
    expect(await service().checkDestination("testnet", STAND_IN)).toMatchObject({
      requiresMediator: true,
      memoType: "id",
      exchangeName: "Stand-in",
    });
  });

  test("on testnet the mediator co-signs a forward to the stand-in only with its id memo", async () => {
    expect(
      await refusal(service().sign("testnet", { transaction: forward("testnet", Memo.none()) }))
    ).toMatchObject({ error: { code: "memo_required" } });
    expect(
      await refusal(service().sign("testnet", { transaction: forward("testnet", Memo.text("x1")) }))
    ).toMatchObject({ error: { code: "invalid_memo" } });
    const signed = await service().sign("testnet", {
      transaction: forward("testnet", Memo.id(MEMO)),
    });
    expect(signed.transaction).toBeString();
  });

  test("on mainnet the relay check does not route the stand-in through the relay", async () => {
    expect(await service().checkDestination("mainnet", STAND_IN)).toMatchObject({
      requiresMediator: false,
      exchangeName: null,
      memoType: null,
    });
  });

  // The mediator is a conduit and never gated on the registry, so on mainnet it applies only the
  // destination's own on-chain memo flag, which this stand-in does not set.
  test("on mainnet the mediator applies no registry memo rule to the stand-in", async () => {
    const signed = await service().sign("mainnet", {
      transaction: forward("mainnet", Memo.none()),
    });
    expect(signed.transaction).toBeString();
  });
});
