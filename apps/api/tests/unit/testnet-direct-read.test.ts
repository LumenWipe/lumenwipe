import { test, expect } from "bun:test";
import { Address, Keypair, StrKey, xdr } from "@stellar/stellar-sdk";
import {
  detectDefiPositionsViaDirectRead,
  addressVal,
  contractDataKey,
  symbolVal,
  variantVal,
} from "@/lib/defi-positions/testnet-direct-read";
import type { ContractRegistryEntry } from "@/lib/contract-registry";
import {
  addressListVal,
  contractDataEntry,
  contractInstanceEntry,
  i128Val,
  mockRpc,
  structVal,
  u32MapVal,
} from "./fixtures/testnet-direct-read-helpers";

const USER = Keypair.random().publicKey();
const ASSET_A = Keypair.random().publicKey();
const ASSET_B = Keypair.random().publicKey();

const BLEND_POOL = "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF";
const BLEND_WASM_HASH = "a41fc53d6753b6c04eb15b021c55052366a4c8e0e21bc72700f461264ec1350e";
const FXDAO_VAULTS = "CBUZ5NJKA5PRS4TBPHWMN4JGGRVIOQOKI4JUYLA2IXS3BEJKQKEWFW7D";
const FXDAO_WASM_HASH = "1".repeat(64);
const AQUARIUS_POOL = "CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD";
const AQUARIUS_WASM_HASH = "2".repeat(64);

function registryEntry(overrides: Partial<ContractRegistryEntry> = {}): ContractRegistryEntry {
  return {
    network: "testnet",
    protocol: "blend",
    kind: "pool",
    address: BLEND_POOL,
    wasmHash: BLEND_WASM_HASH,
    version: "v2",
    label: "test fixture",
    verifiedLive: true,
    ...overrides,
  };
}

test("no registry entries -> a clean empty result, not an error", async () => {
  const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc: mockRpc([]),
    registryEntries: [],
  });
  expect(result.address).toBe(USER);
  expect(result.network).toBe("testnet");
  expect(result.source).toBe("testnet-direct-read");
  expect(result.positions).toEqual([]);
  expect(result.unrecognizedPositions).toEqual([]);
});

test("factory/router/backstop entries are never probed, even when unresolvable", async () => {
  const entries: ContractRegistryEntry[] = [
    registryEntry({ kind: "factory" }),
    registryEntry({ kind: "router" }),
    registryEntry({ kind: "backstop" }),
  ];
  // Empty RPC mock: if these were probed, verifyEntry would flag them as unresolvable.
  const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc: mockRpc([]),
    registryEntries: entries,
  });
  expect(result.positions).toEqual([]);
  expect(result.unrecognizedPositions).toEqual([]);
});

test("a contract the registry expects but the network no longer has is flagged, not silently empty", async () => {
  const entries = [registryEntry({ address: FXDAO_VAULTS, protocol: "fxdao", kind: "vault" })];
  const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc: mockRpc([]),
    registryEntries: entries,
  });
  expect(result.positions).toEqual([]);
  expect(result.unrecognizedPositions).toEqual([
    {
      protocol: "fxdao",
      rawType: "registry-entry-unresolvable",
      reason: expect.stringContaining(FXDAO_VAULTS),
    },
  ]);
});

test("a live wasmHash that doesn't match the registry halts decoding rather than guessing", async () => {
  const entries = [registryEntry()];
  const rpc = mockRpc([contractInstanceEntry(BLEND_POOL, "0".repeat(64))]);
  const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc,
    registryEntries: entries,
  });
  expect(result.positions).toEqual([]);
  expect(result.unrecognizedPositions).toHaveLength(1);
  expect(result.unrecognizedPositions[0]!.rawType).toBe("wasmhash-mismatch");
});

test("decodes Blend supply and borrow positions, resolving reserve index through ResList", async () => {
  const entries = [registryEntry()];
  const resListKey = symbolVal("ResList");
  const positionsKey = variantVal("Positions", addressVal(USER));

  const positionsValue = structVal({
    // reserve index 0 = ASSET_A, index 1 = ASSET_B
    supply: u32MapVal([[0, 500_0000000n]]),
    collateral: u32MapVal([[0, 100_0000000n]]),
    liabilities: u32MapVal([[1, 250_0000000n]]),
  });

  const rpc = mockRpc([
    contractInstanceEntry(BLEND_POOL, BLEND_WASM_HASH),
    contractDataEntry(BLEND_POOL, resListKey, addressListVal([ASSET_A, ASSET_B])),
    contractDataEntry(BLEND_POOL, positionsKey, positionsValue),
  ]);

  const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc,
    registryEntries: entries,
  });
  expect(result.unrecognizedPositions).toEqual([]);

  const supply = result.positions.find((p) => p.positionType === "supply");
  expect(supply).toMatchObject({
    protocol: "blend",
    positionType: "supply",
    assetAddress: ASSET_A,
    bTokenAmount: "6000000000", // 500_0000000 supply + 100_0000000 collateral
  });

  const borrow = result.positions.find((p) => p.positionType === "borrow");
  expect(borrow).toMatchObject({
    protocol: "blend",
    positionType: "borrow",
    assetAddress: ASSET_B,
    dTokenAmount: "2500000000",
  });
});

test("a zero-balance reserve index produces no position, not a zero-amount entry", async () => {
  const entries = [registryEntry()];
  const resListKey = symbolVal("ResList");
  const positionsKey = variantVal("Positions", addressVal(USER));
  const positionsValue = structVal({
    supply: u32MapVal([[0, 0n]]),
    collateral: u32MapVal([]),
    liabilities: u32MapVal([]),
  });

  const rpc = mockRpc([
    contractInstanceEntry(BLEND_POOL, BLEND_WASM_HASH),
    contractDataEntry(BLEND_POOL, resListKey, addressListVal([ASSET_A])),
    contractDataEntry(BLEND_POOL, positionsKey, positionsValue),
  ]);

  const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc,
    registryEntries: entries,
  });
  expect(result.positions).toEqual([]);
  expect(result.unrecognizedPositions).toEqual([]);
});

test("decodes an FxDAO vault only for the denomination the account actually holds", async () => {
  const entries = [
    registryEntry({
      address: FXDAO_VAULTS,
      protocol: "fxdao",
      kind: "vault",
      wasmHash: FXDAO_WASM_HASH,
    }),
  ];

  const usdxKey = variantVal("Vault", xdr.ScVal.scvVec([addressVal(USER), symbolVal("USDx")]));
  const vaultValue = structVal({
    total_collateral: i128Val(1000_0000000n),
    total_debt: i128Val(400_0000000n),
  });

  const rpc = mockRpc([
    contractInstanceEntry(FXDAO_VAULTS, FXDAO_WASM_HASH),
    contractDataEntry(FXDAO_VAULTS, usdxKey, vaultValue),
    // EURx/GBPx keys are queried too but have no matching entry - mockRpc simply omits them.
  ]);

  const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc,
    registryEntries: entries,
  });
  expect(result.unrecognizedPositions).toEqual([]);
  expect(result.positions).toEqual([
    {
      protocol: "fxdao",
      positionType: "cdp",
      contractAddress: FXDAO_VAULTS,
      wasmHash: FXDAO_WASM_HASH,
      denomination: "USDx",
      collateralAmount: "10000000000",
      debtAmount: "4000000000",
      usdValue: null,
    },
  ]);
});

test("decodes a registered pool's LP share balance from the standard token layout", async () => {
  const entries = [
    registryEntry({
      address: AQUARIUS_POOL,
      protocol: "aquarius",
      kind: "pool",
      wasmHash: AQUARIUS_WASM_HASH,
    }),
  ];
  const balanceKey = variantVal("Balance", addressVal(USER));

  const rpc = mockRpc([
    contractInstanceEntry(AQUARIUS_POOL, AQUARIUS_WASM_HASH),
    contractDataEntry(AQUARIUS_POOL, balanceKey, i128Val(42_0000000n)),
  ]);

  const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc,
    registryEntries: entries,
  });
  expect(result.unrecognizedPositions).toEqual([]);
  expect(result.positions).toEqual([
    {
      protocol: "aquarius",
      positionType: "lp",
      contractAddress: AQUARIUS_POOL,
      wasmHash: AQUARIUS_WASM_HASH,
      shareAmount: "420000000",
      usdValue: null,
    },
  ]);
});

test("a zero LP share balance produces no position", async () => {
  const entries = [
    registryEntry({
      address: AQUARIUS_POOL,
      protocol: "aquarius",
      kind: "pool",
      wasmHash: AQUARIUS_WASM_HASH,
    }),
  ];
  const balanceKey = variantVal("Balance", addressVal(USER));

  const rpc = mockRpc([
    contractInstanceEntry(AQUARIUS_POOL, AQUARIUS_WASM_HASH),
    contractDataEntry(AQUARIUS_POOL, balanceKey, i128Val(0n)),
  ]);

  const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc,
    registryEntries: entries,
  });
  expect(result.positions).toEqual([]);
});

test("an entry the registry marks as not live, and that is still absent, is not reported against the account", async () => {
  // Registry-level knowledge (verifiedLive: false) is not a fact about this account. If the
  // still-absent contract were flagged, every account on the network would carry the same
  // "unrecognized position" and the plan gate would block them all on a registry gap.
  const entries = [
    registryEntry({
      address: FXDAO_VAULTS,
      protocol: "fxdao",
      kind: "vault",
      wasmHash: null,
      verifiedLive: false,
    }),
  ];
  const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc: mockRpc([]),
    registryEntries: entries,
  });
  expect(result.positions).toEqual([]);
  expect(result.unrecognizedPositions).toEqual([]);
});

test("an entry the registry marks as not live that has since appeared is flagged - the registry has no hash to read it by", async () => {
  // The skip above is conditional on the network agreeing with the registry. Once the contract
  // resolves, staying silent would be a real fail-open: a position there could exist and the
  // registry records no wasmHash to decode it against.
  const entries = [
    registryEntry({
      address: FXDAO_VAULTS,
      protocol: "fxdao",
      kind: "vault",
      wasmHash: null,
      verifiedLive: false,
    }),
  ];
  const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc: mockRpc([contractInstanceEntry(FXDAO_VAULTS, FXDAO_WASM_HASH)]),
    registryEntries: entries,
  });
  expect(result.positions).toEqual([]);
  expect(result.unrecognizedPositions).toEqual([
    {
      protocol: "fxdao",
      rawType: "registry-entry-unpinned",
      reason: expect.stringContaining(FXDAO_VAULTS),
    },
  ]);
});

// ─── Soroswap: pairs enumerated from the factory ─────────────────────────────

const SOROSWAP_FACTORY = "CDP3HMUH6SMS3S7NPGNDJLULCOXXEPSHY4JKUKMBNQMATHDHWXRRJTBY";
const SOROSWAP_FACTORY_HASH = "86285a9234d3f0d687eaf88efe8d5d72172b38c9a86624c9934c0cbf2aff2993";
/** The pair code the shipped registry knows (every factory-deployed pair shares it). */
const SOROSWAP_PAIR_HASH = "8447525edd62f72ffaf52136358034657ea0511a8fec1cd0ebde649f86cca464";
const PAIR_A = "CAAZMNZDUPXEPLLJOGVQYQOJPXFYDZRYX2AMSXFYNP7Q5IKY7WCH2ZV4";
const PAIR_B = "CAPCU57OPEL6LFYCHPZZPHFR42XQHA74YSOFIC7DGSEDLCGKJOCFOJI7";
const TOKEN_0 = "CBRQHWJDLPYVR4BSVUUWJCZGG4N4FF3CUZKDGRVTE36FAWNEJZEMQRME";
const TOKEN_1 = "CCZGLAUBDKJSQK72QOZHVU7CUWKW45OZWYWCLL27AEK74U2OIBK6LXF2";

function soroswapFactoryEntry(): ContractRegistryEntry {
  return registryEntry({
    protocol: "soroswap",
    kind: "factory",
    address: SOROSWAP_FACTORY,
    wasmHash: SOROSWAP_FACTORY_HASH,
    version: "v1",
  });
}

/** The factory's instance (`TotalPairs`) and one `PairAddressesNIndexed(i)` entry per pair. */
function factoryEntries(pairs: string[]) {
  return [
    contractInstanceEntry(SOROSWAP_FACTORY, SOROSWAP_FACTORY_HASH, [
      [xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("TotalPairs")]), xdr.ScVal.scvU32(pairs.length)],
    ]),
    ...pairs.map((pair, i) =>
      contractDataEntry(
        SOROSWAP_FACTORY,
        variantVal("PairAddressesNIndexed", xdr.ScVal.scvU32(i)),
        new Address(pair).toScVal()
      )
    ),
  ];
}

/** A pair's instance with its tokens in keys 0 and 1, plus the user's share balance. */
function pairEntries(pair: string, shares: bigint, wasmHash = SOROSWAP_PAIR_HASH) {
  return [
    contractInstanceEntry(pair, wasmHash, [
      [xdr.ScVal.scvU32(0), new Address(TOKEN_0).toScVal()],
      [xdr.ScVal.scvU32(1), new Address(TOKEN_1).toScVal()],
    ]),
    contractDataEntry(pair, variantVal("Balance", addressVal(USER)), i128Val(shares)),
  ];
}

test("Soroswap: pairs are enumerated from the factory and a held pair becomes an LP position with its tokens", async () => {
  const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc: mockRpc([
      ...factoryEntries([PAIR_A, PAIR_B]),
      ...pairEntries(PAIR_A, 0n),
      ...pairEntries(PAIR_B, 4_200n),
    ]),
    registryEntries: [soroswapFactoryEntry()],
  });
  expect(result.unrecognizedPositions).toEqual([]);
  expect(result.positions).toEqual([
    {
      protocol: "soroswap",
      positionType: "lp",
      contractAddress: PAIR_B,
      wasmHash: SOROSWAP_PAIR_HASH,
      shareAmount: "4200",
      usdValue: null,
      tokens: [TOKEN_0, TOKEN_1],
    },
  ]);
});

test("Soroswap: a held pair running code the registry has not verified is flagged, not decoded", async () => {
  const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc: mockRpc([...factoryEntries([PAIR_A]), ...pairEntries(PAIR_A, 7n, "9".repeat(64))]),
    registryEntries: [soroswapFactoryEntry()],
  });
  expect(result.positions).toEqual([]);
  expect(result.unrecognizedPositions).toEqual([
    { protocol: "soroswap", rawType: "pair-code-unknown", reason: expect.stringContaining(PAIR_A) },
  ]);
});

test("Soroswap: a factory that does not expose its pair count is flagged", async () => {
  const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc: mockRpc([contractInstanceEntry(SOROSWAP_FACTORY, SOROSWAP_FACTORY_HASH)]),
    registryEntries: [soroswapFactoryEntry()],
  });
  expect(result.positions).toEqual([]);
  expect(result.unrecognizedPositions.map((u) => u.rawType)).toEqual(["factory-unreadable"]);
});

test("Soroswap: an oversized factory is flagged rather than swept", async () => {
  const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc: mockRpc([
      contractInstanceEntry(SOROSWAP_FACTORY, SOROSWAP_FACTORY_HASH, [
        [xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("TotalPairs")]), xdr.ScVal.scvU32(50_000)],
      ]),
    ]),
    registryEntries: [soroswapFactoryEntry()],
  });
  expect(result.unrecognizedPositions.map((u) => u.rawType)).toEqual(["factory-too-large"]);
});

test("Soroswap: a large factory is read in chunks that stay under the RPC's key limit", async () => {
  const pairs = Array.from({ length: 230 }, () =>
    // Any valid C-address works as a pair id for the sweep.
    StrKey.encodeContract(StrKey.decodeEd25519PublicKey(Keypair.random().publicKey()))
  );
  const inner = mockRpc([...factoryEntries(pairs), ...pairEntries(pairs[229]!, 1n)]);
  const sizes: number[] = [];
  const rpc = {
    getLedgerEntries: async (...keys: xdr.LedgerKey[]) => {
      sizes.push(keys.length);
      return inner.getLedgerEntries(...keys);
    },
  } as unknown as typeof inner;
  const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc,
    registryEntries: [soroswapFactoryEntry()],
  });
  expect(result.positions.map((p) => p.contractAddress)).toEqual([pairs[229]]);
  expect(Math.max(...sizes)).toBeLessThanOrEqual(100);
  // 1 factory hash + 1 factory instance + 3 index chunks + 3 balance chunks + 1 pair instance.
  expect(sizes.length).toBe(9);
});

test("the representative pair entry itself is never probed for balances - pairs come from the factory", async () => {
  const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc: mockRpc([]),
    registryEntries: [
      registryEntry({
        protocol: "soroswap",
        kind: "pair",
        address: PAIR_A,
        wasmHash: SOROSWAP_PAIR_HASH,
        version: "v1",
      }),
    ],
  });
  expect(result.positions).toEqual([]);
  expect(result.unrecognizedPositions).toEqual([]);
});
