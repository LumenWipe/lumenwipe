import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  Account,
  Asset,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
  type xdr,
} from "@stellar/stellar-sdk";
import embedded from "@registry/exchange-registry.json";
import type { Network } from "@/config/networks";
import {
  activeRegistry,
  bundledRegistry,
  getMemoRequirement,
  isCexAddress,
  lookupExchange,
  mediatorAllowedFor,
  requiresMediatorForAddress,
  setRegistry,
} from "@/lib/exchange-registry";
import { bundledEntries, mergeServedRegistry } from "@/lib/exchange-registry/merge";
import { destinationRefusal } from "@/lib/plan/destination-check";
import { destinationKind, relayRoute } from "@/lib/plan/destination-kind";
import { confirmedMemo, memoField } from "@/lib/plan/memo-field";
import { isUsableTransferDestination } from "@/lib/plan/transfer-destination";
import { verifyCloseTransaction, VerificationError } from "@/lib/stellar/verify";

const scoped = (embedded.entries as Record<string, unknown>[]).filter((e) => "network" in e);
const STAND_IN = scoped[0]?.address as string;
const COINBASE = "GB5CLRWUCBQ6DFK2LR5ZMWJ7QCVEB3XKMPTQUYCDIYB4DRZJBEW6M26D";
const SOURCE = Keypair.random().publicKey();
const MEMO = "4411";
const PASSPHRASE: Record<Network, string> = {
  mainnet: Networks.PUBLIC,
  testnet: Networks.TESTNET,
};

const before = activeRegistry();
afterEach(() => setRegistry(before));

function entry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    address: Keypair.random().publicKey(),
    name: "Example",
    domain: "example.com",
    requiresMediator: true,
    requiresMemo: true,
    memoType: "id",
    ...over,
  };
}

function served(entries: Record<string, unknown>[]): unknown {
  return { entries, lastVerified: before.lastVerified, validUntil: before.validUntil };
}

function adopt(entries: Record<string, unknown>[]): void {
  const merged = mergeServedRegistry(bundledRegistry(), served(entries));
  if (merged === null) throw new Error("not a registry");
  setRegistry({ ...merged, served: true });
}

function closeXdr(network: Network, ops: xdr.Operation[], memo?: Memo): string {
  const builder = new TransactionBuilder(new Account(SOURCE, "100"), {
    fee: "100",
    networkPassphrase: PASSPHRASE[network],
  }).setTimeout(300);
  for (const op of ops) builder.addOperation(op);
  if (memo) builder.addMemo(memo);
  return builder.build().toEnvelope().toXdr("base64");
}

function relayXdr(network: Network): string {
  const relay = Keypair.random().publicKey();
  return closeXdr(
    network,
    [
      Operation.accountMerge({ destination: relay }),
      Operation.payment({
        destination: STAND_IN,
        asset: Asset.native(),
        amount: "100",
        source: relay,
      }),
    ],
    Memo.id(MEMO)
  );
}

function verify(
  network: Network,
  unsignedXdr: string,
  over: { memo?: string | null; memoType?: "text" | "id" | null } = {},
  servedRegistry?: Parameters<typeof verifyCloseTransaction>[0]["servedRegistry"]
): void {
  verifyCloseTransaction({
    unsignedXdr,
    network,
    servedRegistry,
    expected: {
      source: SOURCE,
      destination: STAND_IN,
      nativeBalance: "100.0000000",
      memo: over.memo === undefined ? MEMO : over.memo,
      memoType: over.memoType === undefined ? "id" : over.memoType,
      claimTrustlineAssets: [],
      transfers: {},
      tokenTransfers: {},
      classicConversions: {},
      tokenConversions: {},
      conversionContracts: [],
      xlmContract: Asset.native().contractId(PASSPHRASE[network]),
      exitContracts: [],
      heldTokenContracts: [],
      positionTokenContracts: [],
      exitFunctions: {},
      accountSigners: [{ key: SOURCE, weight: 1, type: "ed25519_public_key" }],
      accountThresholds: { low: 0, med: 1, high: 1 },
      registryContracts: [],
      protectedTokenContracts: [],
      xbullAssets: {},
      ownTokensByContract: {},
      shareTokenContracts: [],
      debtTokenContracts: [],
      repayTokensByPool: {},
    },
  });
}

function refusalCode(run: () => void): string | null {
  try {
    run();
    return null;
  } catch (error) {
    if (error instanceof VerificationError) return error.code;
    throw error;
  }
}

describe("the shipped testnet stand-in", () => {
  test("is the one network-scoped entry, a testnet-only id-memo exchange that needs the relay", () => {
    expect(scoped).toHaveLength(1);
    expect(scoped[0]).toMatchObject({
      network: "testnet",
      requiresMediator: true,
      requiresMemo: true,
      memoType: "id",
    });
  });

  test("is listed on testnet, with its id memo and the relay", () => {
    expect(lookupExchange(STAND_IN, "testnet")?.memoType).toBe("id");
    expect(isCexAddress(STAND_IN, "testnet")).toBe(true);
    expect(requiresMediatorForAddress(STAND_IN, "testnet")).toBe(true);
    expect(mediatorAllowedFor(STAND_IN, "testnet")).toBe(true);
    expect(getMemoRequirement(STAND_IN, "testnet")).toMatchObject({
      requiresMemo: true,
      memoType: "id",
    });
  });

  test("is invisible to every mainnet lookup", () => {
    expect(lookupExchange(STAND_IN, "mainnet")).toBeNull();
    expect(isCexAddress(STAND_IN, "mainnet")).toBe(false);
    expect(requiresMediatorForAddress(STAND_IN, "mainnet")).toBe(false);
    expect(mediatorAllowedFor(STAND_IN, "mainnet")).toBe(false);
    expect(getMemoRequirement(STAND_IN, "mainnet")).toEqual({
      requiresMemo: false,
      memoType: null,
      exchangeName: null,
    });
  });

  test("an unscoped exchange is listed on both networks", () => {
    for (const network of ["mainnet", "testnet"] as const) {
      expect(lookupExchange(COINBASE, network)?.name).toBe("Coinbase");
      expect(mediatorAllowedFor(COINBASE, network)).toBe(true);
    }
  });
});

describe("parsing the network scope", () => {
  test("the bundled parse keeps an absent or testnet scope", () => {
    const parsed = bundledEntries([entry(), entry({ network: "testnet" })]);
    expect(parsed.map((e) => e.network)).toEqual([undefined, "testnet"]);
  });

  for (const bad of ["mainnet", "", null, "Testnet", "TESTNET", 1, true]) {
    test(`the bundled parse refuses network ${JSON.stringify(bad)}`, () => {
      expect(() => bundledEntries([entry(), entry({ network: bad })])).toThrow(/entry 1/);
    });

    test(`a served entry with network ${JSON.stringify(bad)} is dropped`, () => {
      const added = entry({ network: bad });
      const merged = mergeServedRegistry(bundledRegistry(), served([added]));
      expect(merged?.entries.some((e) => e.address === added.address)).toBe(false);
    });
  }
});

describe("a served snapshot cannot move a bundled entry's scope", () => {
  test("an unscoped served copy of the stand-in keeps it testnet-only", () => {
    adopt([entry({ address: STAND_IN, name: "Widened" })]);
    expect(lookupExchange(STAND_IN, "mainnet")).toBeNull();
    expect(mediatorAllowedFor(STAND_IN, "mainnet")).toBe(false);
    expect(lookupExchange(STAND_IN, "testnet")?.network).toBe("testnet");
  });

  test("a served copy scoping a bundled exchange to testnet keeps it on mainnet", () => {
    adopt([entry({ address: COINBASE, name: "Coinbase", memoType: "text", network: "testnet" })]);
    expect(lookupExchange(COINBASE, "mainnet")?.name).toBe("Coinbase");
    expect(lookupExchange(COINBASE, "mainnet")?.network).toBeUndefined();
  });

  test("an address only the served copy lists as testnet-only is invisible on mainnet", () => {
    const added = entry({ network: "testnet" });
    adopt([added]);
    expect(lookupExchange(added.address as string, "testnet")).not.toBeNull();
    expect(lookupExchange(added.address as string, "mainnet")).toBeNull();
  });
});

describe("the page reads the stand-in by network", () => {
  test("the review routes the stand-in through the relay on testnet only", () => {
    expect(relayRoute(STAND_IN, "testnet")).toBe("relay");
    expect(relayRoute(STAND_IN, "mainnet")).toBe("direct");
    expect(destinationKind(STAND_IN, "testnet", { acknowledgedFor: null }).kind).toBe("exchange");
    expect(destinationKind(STAND_IN, "mainnet", { acknowledgedFor: null })).toEqual({
      kind: "wallet",
    });
  });

  test("the memo type is fixed to id on testnet and the user's on mainnet", () => {
    expect(memoField(STAND_IN, "testnet", MEMO, "text", false)).toMatchObject({
      type: "id",
      typeFixed: true,
      listing: "bundled",
      required: true,
    });
    expect(memoField(STAND_IN, "mainnet", "", "text", false)).toMatchObject({
      type: "text",
      typeFixed: false,
      listing: "unlisted",
      required: false,
    });
    expect(confirmedMemo(STAND_IN, "testnet", MEMO, "text")?.memoType).toBe("id");
    expect(confirmedMemo(STAND_IN, "mainnet", MEMO, "text")?.memoType).toBe("text");
  });

  test("a transfer to the stand-in is refused on testnet only", () => {
    expect(isUsableTransferDestination(STAND_IN, "testnet")).toBe(false);
    expect(isUsableTransferDestination(STAND_IN, "mainnet")).toBe(true);
  });

  test("the destination check holds the API's relay answer to the network", async () => {
    const fetchSpy = spyOn(globalThis, "fetch");
    const answer = (requiresMediator: boolean): void => {
      fetchSpy.mockImplementation((async () =>
        Response.json({
          requiresMediator,
          requiresMemo: requiresMediator,
          available: true,
        })) as unknown as typeof fetch);
    };
    try {
      answer(false);
      expect(await destinationRefusal("mainnet", STAND_IN, "")).toBeNull();
      answer(true);
      expect(await destinationRefusal("mainnet", STAND_IN, MEMO)).toMatch(/could not be confirmed/);
      expect(await destinationRefusal("testnet", STAND_IN, MEMO)).toBeNull();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("verify() holds the stand-in to the network", () => {
  test("a relay close to the stand-in with its id memo is accepted on testnet", () => {
    expect(() => verify("testnet", relayXdr("testnet"))).not.toThrow();
  });

  test("the same relay close is refused on mainnet", () => {
    expect(refusalCode(() => verify("mainnet", relayXdr("mainnet")))).toBe(
      "merge_destination_mismatch"
    );
  });

  test("a served snapshot that drops the scope does not open the relay on mainnet", () => {
    const snapshot = served([entry({ address: STAND_IN, name: "Widened" })]) as Parameters<
      typeof verifyCloseTransaction
    >[0]["servedRegistry"];
    expect(refusalCode(() => verify("mainnet", relayXdr("mainnet"), {}, snapshot))).toBe(
      "merge_destination_mismatch"
    );
    expect(() => verify("testnet", relayXdr("testnet"), {}, snapshot)).not.toThrow();
  });

  test("on testnet a direct merge into the stand-in is refused, and on mainnet it is a wallet", () => {
    const direct = (network: Network): string =>
      closeXdr(network, [Operation.accountMerge({ destination: STAND_IN })]);
    expect(refusalCode(() => verify("testnet", direct("testnet"), { memo: null }))).toBe(
      "merge_direct_refused"
    );
    expect(() =>
      verify("mainnet", direct("mainnet"), { memo: null, memoType: null })
    ).not.toThrow();
  });

  test("on testnet the stand-in's id memo is required", () => {
    const relay = Keypair.random().publicKey();
    const unsignedXdr = closeXdr("testnet", [
      Operation.accountMerge({ destination: relay }),
      Operation.payment({
        destination: STAND_IN,
        asset: Asset.native(),
        amount: "100",
        source: relay,
      }),
    ]);
    expect(refusalCode(() => verify("testnet", unsignedXdr, { memo: null, memoType: null }))).toBe(
      "memo_required"
    );
  });
});
