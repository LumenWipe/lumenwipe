import { test, expect } from "bun:test";
import { UserBalance } from "@blend-capital/blend-sdk";
import { Address, Keypair, StrKey, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import {
  aquariusTokensHash,
  detectDefiPositionsViaDirectRead,
  addressVal,
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
const PHOENIX_POOL = "CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD";
const PHOENIX_WASM_HASH = "2".repeat(64);

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

test("factory/router entries are never probed, even when unresolvable", async () => {
  const entries: ContractRegistryEntry[] = [
    registryEntry({ kind: "factory" }),
    registryEntry({ kind: "router" }),
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

const BACKSTOP = "CBDVWXT433PRVTUNM56C3JREF3HIZHRBA64NB2C3B2UNCKIS65ZYCLZA";
const BACKSTOP_WASM_HASH = "c1f4502a757e25c611f5a159bc1ab0eef64085adac6c68123dca66e87faffbc2";
const BACKSTOP_TOKEN = "CA5UTUUPHYL5K22UBRUVC37EARZUGYOSGK3IKIXG2JLCC5ZZLI4BDWDM";

/** The backstop's `UserBalance(pool, user)` entry: shares not queued plus queued withdrawals. */
function backstopBalanceEntry(shares: bigint, q4w: Array<[bigint, number]>) {
  const key = UserBalance.ledgerKey(BACKSTOP, BLEND_POOL, USER).contractData().key();
  return contractDataEntry(
    BACKSTOP,
    key,
    structVal({
      shares: i128Val(shares),
      q4w: xdr.ScVal.scvVec(
        q4w.map(([amount, exp]) =>
          structVal({ amount: i128Val(amount), exp: nativeToScVal(exp, { type: "u64" }) })
        )
      ),
    })
  );
}
const backstopInstance = () =>
  contractInstanceEntry(BACKSTOP, BACKSTOP_WASM_HASH, [
    [symbolVal("BToken"), addressVal(BACKSTOP_TOKEN)],
  ]);
const blendEntries = () => [
  registryEntry(),
  registryEntry({ kind: "backstop", address: BACKSTOP, wasmHash: BACKSTOP_WASM_HASH }),
];

test("a backstop deposit is read from the backstop for every registered pool: shares plus every queued withdrawal, on the pool it backs", async () => {
  const rpc = mockRpc([
    contractInstanceEntry(BLEND_POOL, BLEND_WASM_HASH),
    backstopInstance(),
    backstopBalanceEntry(5_0000000n, [
      [1_0000000n, 1_700_000_000],
      [2_0000000n, 4_000_000_000],
    ]),
  ]);
  const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc,
    registryEntries: blendEntries(),
  });
  expect(result.unrecognizedPositions).toEqual([]);
  expect(result.positions).toEqual([
    {
      protocol: "blend",
      positionType: "supply",
      contractAddress: BLEND_POOL,
      wasmHash: BLEND_WASM_HASH,
      assetAddress: BACKSTOP_TOKEN,
      bTokenAmount: "80000000",
      usdValue: null,
      isBackstop: true,
    },
  ]);
});

test("no backstop entry, or an empty one, is no position; an unreadable one or a backstop without its token is flagged", async () => {
  const none = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc: mockRpc([contractInstanceEntry(BLEND_POOL, BLEND_WASM_HASH), backstopInstance()]),
    registryEntries: blendEntries(),
  });
  expect(none.positions).toEqual([]);
  expect(none.unrecognizedPositions).toEqual([]);

  const empty = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc: mockRpc([
      contractInstanceEntry(BLEND_POOL, BLEND_WASM_HASH),
      backstopInstance(),
      backstopBalanceEntry(0n, []),
    ]),
    registryEntries: blendEntries(),
  });
  expect(empty.positions).toEqual([]);

  const malformed = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc: mockRpc([
      contractInstanceEntry(BLEND_POOL, BLEND_WASM_HASH),
      backstopInstance(),
      contractDataEntry(
        BACKSTOP,
        UserBalance.ledgerKey(BACKSTOP, BLEND_POOL, USER).contractData().key(),
        i128Val(7n)
      ),
    ]),
    registryEntries: blendEntries(),
  });
  expect(malformed.positions).toEqual([]);
  expect(malformed.unrecognizedPositions.map((u) => u.rawType)).toEqual([
    "backstop-balance-unreadable",
  ]);

  const tokenless = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc: mockRpc([
      contractInstanceEntry(BLEND_POOL, BLEND_WASM_HASH),
      contractInstanceEntry(BACKSTOP, BACKSTOP_WASM_HASH),
      backstopBalanceEntry(5n, []),
    ]),
    registryEntries: blendEntries(),
  });
  expect(tokenless.positions).toEqual([]);
  expect(tokenless.unrecognizedPositions.map((u) => u.rawType)).toEqual(["backstop-token-unknown"]);
});

test("a backstop the network no longer has is flagged like any other registered contract", async () => {
  const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc: mockRpc([contractInstanceEntry(BLEND_POOL, BLEND_WASM_HASH)]),
    registryEntries: blendEntries(),
  });
  expect(result.unrecognizedPositions.map((u) => u.rawType)).toEqual([
    "registry-entry-unresolvable",
  ]);
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
      address: PHOENIX_POOL,
      protocol: "phoenix",
      kind: "pool",
      wasmHash: PHOENIX_WASM_HASH,
    }),
  ];
  const balanceKey = variantVal("Balance", addressVal(USER));

  const rpc = mockRpc([
    contractInstanceEntry(PHOENIX_POOL, PHOENIX_WASM_HASH),
    contractDataEntry(PHOENIX_POOL, balanceKey, i128Val(42_0000000n)),
  ]);

  const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc,
    registryEntries: entries,
  });
  expect(result.unrecognizedPositions).toEqual([]);
  expect(result.positions).toEqual([
    {
      protocol: "phoenix",
      positionType: "lp",
      contractAddress: PHOENIX_POOL,
      wasmHash: PHOENIX_WASM_HASH,
      shareAmount: "420000000",
      usdValue: null,
    },
  ]);
});

test("a zero LP share balance produces no position", async () => {
  const entries = [
    registryEntry({
      address: PHOENIX_POOL,
      protocol: "phoenix",
      kind: "pool",
      wasmHash: PHOENIX_WASM_HASH,
    }),
  ];
  const balanceKey = variantVal("Balance", addressVal(USER));

  const rpc = mockRpc([
    contractInstanceEntry(PHOENIX_POOL, PHOENIX_WASM_HASH),
    contractDataEntry(PHOENIX_POOL, balanceKey, i128Val(0n)),
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
/** The pair code every factory-deployed pair shares; injected below, never read from the shipped file. */
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

/** The representative pair entry: the code hash every held pair is checked against. */
function soroswapPairEntry(): ContractRegistryEntry {
  return registryEntry({
    protocol: "soroswap",
    kind: "pair",
    address: PAIR_A,
    wasmHash: SOROSWAP_PAIR_HASH,
    version: "v1",
  });
}

const SOROSWAP_REGISTRY = (): ContractRegistryEntry[] => [
  soroswapFactoryEntry(),
  soroswapPairEntry(),
];

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
    registryEntries: SOROSWAP_REGISTRY(),
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
    registryEntries: SOROSWAP_REGISTRY(),
  });
  expect(result.positions).toEqual([]);
  expect(result.unrecognizedPositions).toEqual([
    { protocol: "soroswap", rawType: "pair-code-unknown", reason: expect.stringContaining(PAIR_A) },
  ]);
});

test("Soroswap: a factory that does not expose its pair count is flagged", async () => {
  const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc: mockRpc([contractInstanceEntry(SOROSWAP_FACTORY, SOROSWAP_FACTORY_HASH)]),
    registryEntries: SOROSWAP_REGISTRY(),
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
    registryEntries: SOROSWAP_REGISTRY(),
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
    registryEntries: SOROSWAP_REGISTRY(),
  });
  expect(result.positions.map((p) => p.contractAddress)).toEqual([pairs[229]]);
  expect(Math.max(...sizes)).toBeLessThanOrEqual(100);
  // 1 factory hash + 1 factory instance + 3 index chunks + 3 balance chunks + 1 held-pair chunk.
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

test("Soroswap: an index the ledger does not return is reported as a gap, and the rest still resolve", async () => {
  const [factoryInstance, indexA] = factoryEntries([PAIR_A, PAIR_B]);
  // TotalPairs says 2, but only index 0 is on the ledger.
  const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc: mockRpc([factoryInstance!, indexA!, ...pairEntries(PAIR_A, 5n)]),
    registryEntries: SOROSWAP_REGISTRY(),
  });
  expect(result.positions.map((p) => p.contractAddress)).toEqual([PAIR_A]);
  expect(result.unrecognizedPositions.map((u) => u.rawType)).toEqual(["factory-index-gap"]);
});

test("Soroswap: the same pair listed twice in the index yields one position", async () => {
  const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc: mockRpc([...factoryEntries([PAIR_A, PAIR_A]), ...pairEntries(PAIR_A, 5n)]),
    registryEntries: SOROSWAP_REGISTRY(),
  });
  expect(result.positions).toHaveLength(1);
  // Two indices, one distinct address: the sweep says so rather than pretending it saw two.
  expect(result.unrecognizedPositions.map((u) => u.rawType)).toEqual(["factory-index-gap"]);
});

test("Soroswap: a held pair with no instance on the ledger is flagged with that reason", async () => {
  const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc: mockRpc([
      ...factoryEntries([PAIR_A]),
      contractDataEntry(PAIR_A, variantVal("Balance", addressVal(USER)), i128Val(3n)),
    ]),
    registryEntries: SOROSWAP_REGISTRY(),
  });
  expect(result.positions).toEqual([]);
  expect(result.unrecognizedPositions[0]!.reason).toContain("no contract instance");
});

test("Soroswap: a balance that is not an amount is treated as no position, like any other LP read", async () => {
  const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc: mockRpc([
      ...factoryEntries([PAIR_A]),
      contractDataEntry(PAIR_A, variantVal("Balance", addressVal(USER)), xdr.ScVal.scvSymbol("x")),
    ]),
    registryEntries: SOROSWAP_REGISTRY(),
  });
  expect(result.positions).toEqual([]);
  expect(result.unrecognizedPositions).toEqual([]);
});

test("Soroswap: tokens are omitted when the pair instance lacks them, and odd storage keys are skipped", async () => {
  const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc: mockRpc([
      ...factoryEntries([PAIR_A]),
      contractInstanceEntry(PAIR_A, SOROSWAP_PAIR_HASH, [
        // A u64 key: scValToNative yields a bigint, which JSON.stringify cannot encode.
        [xdr.ScVal.scvU64(xdr.Uint64.fromString("7")), xdr.ScVal.scvU32(1)],
        [xdr.ScVal.scvSymbol("METADATA"), xdr.ScVal.scvSymbol("ignored")],
      ]),
      contractDataEntry(PAIR_A, variantVal("Balance", addressVal(USER)), i128Val(9n)),
    ]),
    registryEntries: SOROSWAP_REGISTRY(),
  });
  expect(result.positions).toHaveLength(1);
  expect("tokens" in result.positions[0]!).toBe(false);
  expect(result.unrecognizedPositions).toEqual([]);
});

test("Soroswap: without a pair entry in the registry, every held pair is unknown code", async () => {
  const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc: mockRpc([...factoryEntries([PAIR_A]), ...pairEntries(PAIR_A, 5n)]),
    registryEntries: [soroswapFactoryEntry()],
  });
  expect(result.positions).toEqual([]);
  expect(result.unrecognizedPositions.map((u) => u.rawType)).toEqual(["pair-code-unknown"]);
});

// ─── Aquarius: pools enumerated from the router ──────────────────────────────

const AQ_ROUTER = "CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD";
const AQ_ROUTER_HASH = "c99539b023df4a28d7857d33ca4c915c2e20fec04f12b125132b84fbdf94dad3";
const AQ_CONSTANT_HASH = "d691135aade93ff0f7c229e009cde042130a05124cf7202b03d11246b4f9b473";
const AQ_STABLE_HASH = "22dff7242d2bc0ea4a4727b4b2cac33b188304d5945740ad24d8a33a5d22741e";
const AQ_CONCENTRATED_HASH = "155a17b9929ffb1f9e84bd6ef5c00a4d613c1ab5f4ad4c502d84515250cc2907";
const AQ_POOL_CONSTANT = "CDLYWB5CCSNOEXPGHSKYO4FW3R4XFQVI2HR2QC735YDVCSEQJABQDFXI";
const AQ_POOL_STABLE = "CDDLEQE6CPQGIK3RU4MK5CX2IAWN6CXWNJ2C3VOXV4FOVF3BBQFVZDIC";
const AQ_POOL_CONCENTRATED = "CCS6EFFKPQWG5SKMMYL4UQIXVYVDNIXAPHKHUM7IGJVN7QIAWXD2L7TO";
const AQ_SHARE_CONSTANT = "CAN7DMIQH7FGKNYCUQMWECJJ74EKN5JATVVUOVTXOWLQGZCWAFWANG5P";
const AQ_SHARE_STABLE = "CATORI2GO3MB5S6JJCXCTDHMTNXRYR2YV7GU5EWQQ4KS5ANWVACUKLBE";
const AQ_TOKEN_A = "CAZRY5GSFBFXD7H6GAFBA5YGYQTDXU4QKWKMYFWBAZFUCURN3WKX6LF5";
const AQ_TOKEN_B = "CBL6KD2LFMLAUKFFWNNXWOXFN73GAXLEA4WMJRLQ5L76DMYTM3KWQVJN";

function aquariusRegistry(): ContractRegistryEntry[] {
  const pool = (address: string, wasmHash: string, version: string): ContractRegistryEntry =>
    registryEntry({ protocol: "aquarius", kind: "pool", address, wasmHash, version });
  return [
    registryEntry({
      protocol: "aquarius",
      kind: "router",
      address: AQ_ROUTER,
      wasmHash: AQ_ROUTER_HASH,
      version: "v1",
    }),
    pool(AQ_POOL_CONSTANT, AQ_CONSTANT_HASH, "constant_product"),
    pool(AQ_POOL_STABLE, AQ_STABLE_HASH, "stable"),
    pool(AQ_POOL_CONCENTRATED, AQ_CONCENTRATED_HASH, "concentrated"),
  ];
}

const u128 = (n: number): xdr.ScVal =>
  xdr.ScVal.scvU128(
    new xdr.UInt128Parts({ hi: xdr.Uint64.fromString("0"), lo: xdr.Uint64.fromString(String(n)) })
  );
const sym = (s: string): xdr.ScVal => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(s)]);
const addrVal = (a: string): xdr.ScVal => new Address(a).toScVal();

/** The router's instance (`TokensSetCounter`), each `TokensSet(i)`, and each set's pool map. */
function aquariusRouterEntries(sets: Array<{ tokens: string[]; pools: string[] }>) {
  const entries = [
    contractInstanceEntry(AQ_ROUTER, AQ_ROUTER_HASH, [
      [sym("TokensSetCounter"), u128(sets.length)],
    ]),
  ];
  sets.forEach(({ tokens, pools }, i) => {
    entries.push(
      contractDataEntry(
        AQ_ROUTER,
        variantVal("TokensSet", u128(i)),
        xdr.ScVal.scvVec(tokens.map(addrVal))
      ),
      contractDataEntry(
        AQ_ROUTER,
        variantVal("TokensSetPools", xdr.ScVal.scvBytes(aquariusTokensHash(tokens))),
        xdr.ScVal.scvMap(
          pools.map(
            (pool, j) =>
              new xdr.ScMapEntry({
                key: xdr.ScVal.scvBytes(Buffer.alloc(32, j + 1)),
                // The router stores `{ address, pool_type }` per pool; its getter unwraps it.
                val: structVal({ address: addrVal(pool), pool_type: xdr.ScVal.scvU32(j + 1) }),
              })
          )
        )
      )
    );
  });
  return entries;
}

function constantPool(
  pool: string,
  share: string,
  shares: bigint | null,
  wasmHash = AQ_CONSTANT_HASH
) {
  const out = [
    contractInstanceEntry(pool, wasmHash, [
      [sym("TokenA"), addrVal(AQ_TOKEN_A)],
      [sym("TokenB"), addrVal(AQ_TOKEN_B)],
      [sym("TokenShare"), addrVal(share)],
    ]),
  ];
  if (shares !== null)
    out.push(contractDataEntry(share, variantVal("Balance", addressVal(USER)), i128Val(shares)));
  return out;
}

function stablePool(pool: string, share: string, shares: bigint | null) {
  const out = [
    contractInstanceEntry(pool, AQ_STABLE_HASH, [
      [sym("Tokens"), xdr.ScVal.scvVec([addrVal(AQ_TOKEN_A), addrVal(AQ_TOKEN_B)])],
      [sym("TokenShare"), addrVal(share)],
    ]),
  ];
  if (shares !== null)
    out.push(contractDataEntry(share, variantVal("Balance", addressVal(USER)), i128Val(shares)));
  return out;
}

test("Aquarius: pools are enumerated from the router; held constant-product and stableswap pools become LP positions with tokens, share token, and pool type", async () => {
  const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc: mockRpc([
      ...aquariusRouterEntries([
        { tokens: [AQ_TOKEN_A, AQ_TOKEN_B], pools: [AQ_POOL_CONSTANT, AQ_POOL_STABLE] },
      ]),
      ...constantPool(AQ_POOL_CONSTANT, AQ_SHARE_CONSTANT, 700n),
      ...stablePool(AQ_POOL_STABLE, AQ_SHARE_STABLE, 0n),
    ]),
    registryEntries: aquariusRegistry(),
  });
  expect(result.unrecognizedPositions).toEqual([]);
  expect(result.positions).toEqual([
    {
      protocol: "aquarius",
      positionType: "lp",
      contractAddress: AQ_POOL_CONSTANT,
      wasmHash: AQ_CONSTANT_HASH,
      shareAmount: "700",
      usdValue: null,
      tokens: [AQ_TOKEN_A, AQ_TOKEN_B],
      shareToken: AQ_SHARE_CONSTANT,
      poolType: "constant_product",
    },
  ]);
});

test("Aquarius: a stableswap pool reads its token list; a concentrated pool is skipped (no share token to read)", async () => {
  const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc: mockRpc([
      ...aquariusRouterEntries([
        { tokens: [AQ_TOKEN_A, AQ_TOKEN_B], pools: [AQ_POOL_STABLE, AQ_POOL_CONCENTRATED] },
      ]),
      ...stablePool(AQ_POOL_STABLE, AQ_SHARE_STABLE, 5n),
      // Given a share token and a balance on purpose: only the registry's pool code may skip it.
      contractInstanceEntry(AQ_POOL_CONCENTRATED, AQ_CONCENTRATED_HASH, [
        [sym("TokenShare"), addrVal(AQ_SHARE_STABLE)],
      ]),
      contractDataEntry(AQ_SHARE_STABLE, variantVal("Balance", addressVal(USER)), i128Val(5n)),
    ]),
    registryEntries: aquariusRegistry(),
  });
  expect(result.unrecognizedPositions).toEqual([]);
  expect(
    result.positions.map((p) => [p.contractAddress, "poolType" in p ? p.poolType : null])
  ).toEqual([[AQ_POOL_STABLE, "stable"]]);
});

test("Aquarius: shares in a pool whose code the registry has not verified are flagged, not decoded", async () => {
  const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc: mockRpc([
      ...aquariusRouterEntries([{ tokens: [AQ_TOKEN_A, AQ_TOKEN_B], pools: [AQ_POOL_CONSTANT] }]),
      ...constantPool(AQ_POOL_CONSTANT, AQ_SHARE_CONSTANT, 9n, "7".repeat(64)),
    ]),
    registryEntries: aquariusRegistry(),
  });
  expect(result.positions).toEqual([]);
  expect(result.unrecognizedPositions.map((u) => u.rawType)).toEqual(["pool-code-unknown"]);
});

test("Aquarius: a router that does not expose its count, or a token set the ledger does not return, is reported", async () => {
  const unreadable = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc: mockRpc([contractInstanceEntry(AQ_ROUTER, AQ_ROUTER_HASH)]),
    registryEntries: aquariusRegistry(),
  });
  expect(unreadable.unrecognizedPositions.map((u) => u.rawType)).toEqual(["router-unreadable"]);

  const [routerInstance] = aquariusRouterEntries([{ tokens: [AQ_TOKEN_A, AQ_TOKEN_B], pools: [] }]);
  const gap = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc: mockRpc([routerInstance!]),
    registryEntries: aquariusRegistry(),
  });
  expect(gap.unrecognizedPositions.map((u) => u.rawType)).toEqual(["router-index-gap"]);
});

test("Aquarius: the pool entries in the registry are never read for balances themselves", async () => {
  const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc: mockRpc([]),
    registryEntries: aquariusRegistry().filter((e) => e.kind === "pool"),
  });
  expect(result.positions).toEqual([]);
  expect(result.unrecognizedPositions).toEqual([]);
});

test("aquariusTokensHash matches the router's key for a live token set", () => {
  // Observed in the footprint of router.get_pools([token_a, token_b]) on testnet.
  expect(aquariusTokensHash([AQ_TOKEN_A, AQ_TOKEN_B]).toString("hex")).toBe(
    "f5c621268ea00802f00c31f0914abe205a0db21c4e5fe4869f960b781a0d32f8"
  );
});

test("Aquarius: a pool listed by the router whose instance the ledger does not return is reported", async () => {
  const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc: mockRpc([
      ...aquariusRouterEntries([{ tokens: [AQ_TOKEN_A, AQ_TOKEN_B], pools: [AQ_POOL_CONSTANT] }]),
    ]),
    registryEntries: aquariusRegistry(),
  });
  expect(result.unrecognizedPositions.map((u) => u.rawType)).toEqual(["pool-unreadable"]);
});

test("Aquarius: a token set whose pool map is missing, or a pool entry that does not decode, counts as a gap", async () => {
  const [routerInstance, setEntry] = aquariusRouterEntries([
    { tokens: [AQ_TOKEN_A, AQ_TOKEN_B], pools: [AQ_POOL_CONSTANT] },
  ]);
  const missingMap = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc: mockRpc([routerInstance!, setEntry!]),
    registryEntries: aquariusRegistry(),
  });
  expect(missingMap.unrecognizedPositions.map((u) => u.rawType)).toEqual(["router-index-gap"]);

  const oddEntry = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc: mockRpc([
      routerInstance!,
      setEntry!,
      contractDataEntry(
        AQ_ROUTER,
        variantVal(
          "TokensSetPools",
          xdr.ScVal.scvBytes(aquariusTokensHash([AQ_TOKEN_A, AQ_TOKEN_B]))
        ),
        xdr.ScVal.scvMap([
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvBytes(Buffer.alloc(32, 1)),
            val: xdr.ScVal.scvU32(7),
          }),
        ])
      ),
    ]),
    registryEntries: aquariusRegistry(),
  });
  expect(oddEntry.unrecognizedPositions.map((u) => u.rawType)).toEqual(["router-index-gap"]);
});

test("Aquarius: a pool of unverified code with no share token is flagged - its position, if any, cannot be read", async () => {
  const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc: mockRpc([
      ...aquariusRouterEntries([{ tokens: [AQ_TOKEN_A, AQ_TOKEN_B], pools: [AQ_POOL_CONSTANT] }]),
      contractInstanceEntry(AQ_POOL_CONSTANT, "8".repeat(64), [[sym("Liquidity"), i128Val(1n)]]),
    ]),
    registryEntries: aquariusRegistry(),
  });
  expect(result.unrecognizedPositions.map((u) => u.rawType)).toEqual(["pool-code-unknown"]);
});

test("Aquarius: a registry pool entry with a version this read does not know is reported against the registry", async () => {
  const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc: mockRpc([...aquariusRouterEntries([])]),
    registryEntries: [
      ...aquariusRegistry(),
      registryEntry({
        protocol: "aquarius",
        kind: "pool",
        address: PHOENIX_POOL,
        wasmHash: "9".repeat(64),
        version: "stableswap",
      }),
    ],
  });
  expect(result.unrecognizedPositions.map((u) => u.rawType)).toEqual(["registry-version-unknown"]);
});

test("Aquarius: tokens are omitted when the pool instance does not list every one, and a bare-address pool entry still decodes", async () => {
  const [routerInstance, setEntry] = aquariusRouterEntries([
    { tokens: [AQ_TOKEN_A, AQ_TOKEN_B], pools: [] },
  ]);
  const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc: mockRpc([
      routerInstance!,
      setEntry!,
      contractDataEntry(
        AQ_ROUTER,
        variantVal(
          "TokensSetPools",
          xdr.ScVal.scvBytes(aquariusTokensHash([AQ_TOKEN_A, AQ_TOKEN_B]))
        ),
        xdr.ScVal.scvMap([
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvBytes(Buffer.alloc(32, 1)),
            val: addrVal(AQ_POOL_CONSTANT),
          }),
        ])
      ),
      contractInstanceEntry(AQ_POOL_CONSTANT, AQ_CONSTANT_HASH, [
        [sym("TokenA"), addrVal(AQ_TOKEN_A)],
        [sym("TokenShare"), addrVal(AQ_SHARE_CONSTANT)],
      ]),
      contractDataEntry(AQ_SHARE_CONSTANT, variantVal("Balance", addressVal(USER)), i128Val(3n)),
    ]),
    registryEntries: aquariusRegistry(),
  });
  expect(result.unrecognizedPositions).toEqual([]);
  expect(result.positions).toHaveLength(1);
  expect("tokens" in result.positions[0]!).toBe(false);
});
