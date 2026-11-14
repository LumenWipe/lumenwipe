import { test, expect } from "bun:test";
import { UserBalance } from "@blend-capital/blend-sdk";
import { Address, Keypair, StrKey, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import {
  aquariusTokensHash,
  detectDefiPositionsViaDirectRead,
  enumerateAquariusPools,
  addressVal,
  symbolVal,
  variantVal,
  LEDGER_KEYS_PER_CALL,
  LEDGER_READ_CONCURRENCY,
} from "@/lib/defi-positions/testnet-direct-read";
import type { ContractRegistryEntry } from "@/lib/contract-registry";
import type { PhoenixStakePosition } from "@lumenwipe/types";
import {
  addressListVal,
  contractDataEntry,
  contractInstanceEntry,
  executableTagEntry,
  externalRefInstanceEntry,
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
const PHOENIX_SHARE = "CC53IRMBHWTXE4BWPD5N4LH2L43YSYBMOFD6UARPMZBTWPSODFFKW2EG";
const FXDAO_STABLE = "CAEGVALLV7CA2SIFEDJNA52RKGUWRQWQXM5YNFUH7TH5G6X6QXMRQM4L";
const PHOENIX_STAKE = StrKey.encodeContract(Buffer.alloc(32, 7));
const PHOENIX_STAKE_WASM_HASH = "3".repeat(64);

/** A Phoenix pool's persistent `CONFIG`, naming its separate share token and stake contract;
 *  a null stake contract leaves the field out. */
const phoenixConfigEntry = (
  shareToken: xdr.ScVal = new Address(PHOENIX_SHARE).toScVal(),
  stakeContract: xdr.ScVal | null = new Address(PHOENIX_STAKE).toScVal()
) =>
  contractDataEntry(
    PHOENIX_POOL,
    xdr.ScVal.scvSymbol("CONFIG"),
    structVal({
      share_token: shareToken,
      ...(stakeContract ? { stake_contract: stakeContract } : {}),
      token_a: new Address(FXDAO_VAULTS).toScVal(),
      token_b: new Address(FXDAO_STABLE).toScVal(),
    })
  );

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

const balanceLedgerKey = (): Extract<xdr.LedgerKey, { type: "contractData" }> => {
  const key = xdr.LedgerKey.fromXdr(
    UserBalance.ledgerKey(BACKSTOP, BLEND_POOL, USER).toXDR("base64"),
    "base64"
  );
  if (key.type !== "contractData") throw new Error("expected a contract data key");
  return key;
};

/** The backstop's `UserBalance(pool, user)` entry: shares not queued plus queued withdrawals. */
function backstopBalanceEntry(shares: bigint, q4w: Array<[bigint, number]>) {
  const key = balanceLedgerKey().contractData.key;
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
      contractDataEntry(BACKSTOP, balanceLedgerKey().contractData.key, i128Val(7n)),
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

/** The registered testnet vault and the instance storage it really carries: one denomination,
 *  the lowercase symbol `usd`, as read from the live instance on 2026-11-08. */
const FXDAO_TESTNET_VAULT = "CBETTPAGB46UYACPNU7MFH4D26TTNCDZXOKJ5N3C7PYKU22AIC4C573N";

const fxdaoEntries = (address = FXDAO_VAULTS) => [
  registryEntry({ address, protocol: "fxdao", kind: "vault", wasmHash: FXDAO_WASM_HASH }),
];

const fxdaoVaultKey = (denomination: string) =>
  variantVal("Vault", xdr.ScVal.scvVec([addressVal(USER), symbolVal(denomination)]));

/** `Currency(denomination)` and `VaultsInfo(denomination)`, the two instance keys a denomination
 *  the vault has registered carries. */
const fxdaoDenominationStorage = (
  denomination: xdr.ScVal,
  stable: xdr.ScVal = new Address(FXDAO_STABLE).toScVal()
): Array<[xdr.ScVal, xdr.ScVal]> => [
  [
    xdr.ScVal.scvVec([symbolVal("Currency"), denomination]),
    structVal({ active: xdr.ScVal.scvBool(true), contract: stable, denomination }),
  ],
  [
    xdr.ScVal.scvVec([symbolVal("VaultsInfo"), denomination]),
    structVal({ denomination, lowest_key: xdr.ScVal.scvVec([symbolVal("None")]) }),
  ],
];

const fxdaoVault = (address: string, denomination: string, collateral: bigint, debt: bigint) =>
  contractDataEntry(
    address,
    fxdaoVaultKey(denomination),
    structVal({ total_collateral: i128Val(collateral), total_debt: i128Val(debt) })
  );

test("FxDAO: the vault is probed under the denomination symbol its instance stores, the real testnet key shape", async () => {
  const instance = contractInstanceEntry(
    FXDAO_TESTNET_VAULT,
    FXDAO_WASM_HASH,
    fxdaoDenominationStorage(symbolVal("usd"))
  );
  const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc: mockRpc([instance, fxdaoVault(FXDAO_TESTNET_VAULT, "usd", 1000_0000000n, 400_0000000n)]),
    registryEntries: fxdaoEntries(FXDAO_TESTNET_VAULT),
  });
  expect(result.unrecognizedPositions).toEqual([]);
  expect(result.positions).toEqual([
    {
      protocol: "fxdao",
      positionType: "cdp",
      contractAddress: FXDAO_TESTNET_VAULT,
      wasmHash: FXDAO_WASM_HASH,
      denomination: "usd",
      collateralAmount: "10000000000",
      debtAmount: "4000000000",
      debtToken: FXDAO_STABLE,
      usdValue: null,
    },
  ]);

  // A vault under the stablecoin's ticker is not one the contract can hold: it is never probed.
  const underTicker = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc: mockRpc([instance, fxdaoVault(FXDAO_TESTNET_VAULT, "USDx", 10n, 4n)]),
    registryEntries: fxdaoEntries(FXDAO_TESTNET_VAULT),
  });
  expect(underTicker.positions).toEqual([]);
});

test("FxDAO: every denomination the instance registers is probed, and only the held one is reported", async () => {
  // The mainnet vault's shape: three uppercase denominations.
  const storage = ["USD", "EUR", "GBP"].flatMap((d) => fxdaoDenominationStorage(symbolVal(d)));
  const queried: string[] = [];
  const ledger = mockRpc([
    contractInstanceEntry(FXDAO_VAULTS, FXDAO_WASM_HASH, storage),
    fxdaoVault(FXDAO_VAULTS, "EUR", 10n, 4n),
  ]);
  const rpc = {
    getLedgerEntries: async (...keys: xdr.LedgerKey[]) => {
      for (const key of keys) queried.push(key.toXdr("base64"));
      return ledger.getLedgerEntries(...keys);
    },
  } as unknown as typeof ledger;
  const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc,
    registryEntries: fxdaoEntries(),
  });
  expect(result.positions.map((p) => ("denomination" in p ? p.denomination : null))).toEqual([
    "EUR",
  ]);
  for (const denomination of ["USD", "EUR", "GBP"]) {
    const key = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Address(FXDAO_VAULTS).toScAddress(),
        key: fxdaoVaultKey(denomination),
        durability: xdr.ContractDataDurability.persistent,
      })
    );
    expect(queried).toContain(key.toXdr("base64"));
  }
});

test("FxDAO: a denomination stored as a string, not a symbol, is not probed", async () => {
  const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc: mockRpc([
      contractInstanceEntry(
        FXDAO_VAULTS,
        FXDAO_WASM_HASH,
        fxdaoDenominationStorage(xdr.ScVal.scvString("usd"))
      ),
      fxdaoVault(FXDAO_VAULTS, "usd", 10n, 4n),
    ]),
    registryEntries: fxdaoEntries(),
  });
  expect(result.positions).toEqual([]);
  expect(result.unrecognizedPositions).toEqual([]);
});

const phoenixRegistry = () => [
  registryEntry({
    address: PHOENIX_POOL,
    protocol: "phoenix",
    kind: "pool",
    wasmHash: PHOENIX_WASM_HASH,
  }),
];

test("Phoenix: LP shares are read on the share token the pool's CONFIG names, and the position carries it", async () => {
  const balanceKey = variantVal("Balance", addressVal(USER));
  const rpc = mockRpc([
    contractInstanceEntry(PHOENIX_POOL, PHOENIX_WASM_HASH),
    phoenixConfigEntry(),
    contractDataEntry(PHOENIX_SHARE, balanceKey, i128Val(42_0000000n)),
  ]);

  const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc,
    registryEntries: phoenixRegistry(),
  });
  expect(result.unrecognizedPositions).toEqual([]);
  expect(result.positions).toEqual([
    {
      protocol: "phoenix",
      positionType: "lp",
      contractAddress: PHOENIX_POOL,
      wasmHash: PHOENIX_WASM_HASH,
      shareAmount: "420000000",
      shareToken: PHOENIX_SHARE,
      usdValue: null,
    },
  ]);
});

test("Phoenix: a balance on the pool itself is not a position; the pool is not its share token", async () => {
  const balanceKey = variantVal("Balance", addressVal(USER));
  const rpc = mockRpc([
    contractInstanceEntry(PHOENIX_POOL, PHOENIX_WASM_HASH),
    phoenixConfigEntry(),
    contractDataEntry(PHOENIX_POOL, balanceKey, i128Val(42_0000000n)),
  ]);
  const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc,
    registryEntries: phoenixRegistry(),
  });
  expect(result.positions).toEqual([]);
});

test("Phoenix: a zero balance, a missing CONFIG, or a share token that is not a contract produces no position", async () => {
  const balanceKey = variantVal("Balance", addressVal(USER));
  const held = contractDataEntry(PHOENIX_SHARE, balanceKey, i128Val(42_0000000n));
  const instance = contractInstanceEntry(PHOENIX_POOL, PHOENIX_WASM_HASH);
  for (const ledger of [
    [instance, phoenixConfigEntry(), contractDataEntry(PHOENIX_SHARE, balanceKey, i128Val(0n))],
    [instance, held],
    [instance, phoenixConfigEntry(addressVal(USER)), held],
  ]) {
    const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
      rpc: mockRpc(ledger),
      registryEntries: phoenixRegistry(),
    });
    expect(result.positions).toEqual([]);
  }
});

const phoenixStakeRegistry = (stakeHash: string | null = PHOENIX_STAKE_WASM_HASH) => [
  ...phoenixRegistry(),
  registryEntry({
    address: PHOENIX_STAKE,
    protocol: "phoenix",
    kind: "stake",
    wasmHash: stakeHash,
  }),
];

/** The stake contract's `BondingInfo` for USER, keyed by the bare account address. */
const bondingEntry = (stakes: Array<[bigint, bigint]>, contract: string = PHOENIX_STAKE) =>
  contractDataEntry(
    contract,
    new Address(USER).toScVal(),
    structVal({
      last_reward_time: nativeToScVal(0n, { type: "u64" }),
      reward_debt: nativeToScVal(0n, { type: "u128" }),
      stakes: xdr.ScVal.scvVec(
        stakes.map(([amount, at]) =>
          structVal({
            stake: i128Val(amount),
            stake_timestamp: nativeToScVal(at, { type: "u64" }),
          })
        )
      ),
      total_stake: i128Val(stakes.reduce((sum, [amount]) => sum + amount, 0n)),
    })
  );

/** The bonding key built by hand: persistent, keyed by the account's bare ScAddress. */
const BARE_BONDING_KEY = xdr.LedgerKey.contractData(
  new xdr.LedgerKeyContractData({
    contract: new Address(PHOENIX_STAKE).toScAddress(),
    key: xdr.ScVal.scvAddress(new Address(USER).toScAddress()),
    durability: xdr.ContractDataDurability.persistent,
  })
).toXdr("base64");

const phoenixShares = (amount: bigint) =>
  contractDataEntry(PHOENIX_SHARE, variantVal("Balance", addressVal(USER)), i128Val(amount));

const phoenixLedger = (...extra: ReturnType<typeof contractDataEntry>[]) => [
  contractInstanceEntry(PHOENIX_POOL, PHOENIX_WASM_HASH),
  contractInstanceEntry(PHOENIX_STAKE, PHOENIX_STAKE_WASM_HASH),
  phoenixConfigEntry(),
  ...extra,
];

const phoenixStake = (amount: string, at: string): PhoenixStakePosition => ({
  protocol: "phoenix",
  positionType: "stake",
  contractAddress: PHOENIX_POOL,
  wasmHash: PHOENIX_WASM_HASH,
  stakedAmount: amount,
  stakedAtEpoch: at,
  shareToken: PHOENIX_SHARE,
  usdValue: null,
});

test("Phoenix: an account that bonded every share is reported by its stakes, oldest first, on the pool", async () => {
  for (const shares of [[phoenixShares(0n)], []]) {
    const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
      rpc: mockRpc(
        phoenixLedger(
          ...shares,
          bondingEntry([
            [3_0000000n, 1_700_000_200n],
            [2_0000000n, 1_700_000_100n],
          ])
        )
      ),
      registryEntries: phoenixStakeRegistry(),
    });
    expect(result.unrecognizedPositions).toEqual([]);
    expect(result.positions).toEqual([
      phoenixStake("20000000", "1700000100"),
      phoenixStake("30000000", "1700000200"),
    ]);
  }
});

test("Phoenix: a partly staked account reports its LP shares first, then its stake", async () => {
  const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc: mockRpc(phoenixLedger(phoenixShares(5n), bondingEntry([[7n, 9n]]))),
    registryEntries: phoenixStakeRegistry(),
  });
  expect(result.unrecognizedPositions).toEqual([]);
  expect(result.positions).toEqual([
    {
      protocol: "phoenix",
      positionType: "lp",
      contractAddress: PHOENIX_POOL,
      wasmHash: PHOENIX_WASM_HASH,
      shareAmount: "5",
      shareToken: PHOENIX_SHARE,
      usdValue: null,
    },
    phoenixStake("7", "9"),
  ]);
});

test("Phoenix: no bonding entry, an empty one, or a zero stake adds no stake position", async () => {
  for (const bonding of [[], [bondingEntry([])], [bondingEntry([[0n, 9n]])]]) {
    const staked = await detectDefiPositionsViaDirectRead(USER, "testnet", {
      rpc: mockRpc(phoenixLedger(phoenixShares(5n), ...bonding)),
      registryEntries: phoenixStakeRegistry(),
    });
    expect(staked.unrecognizedPositions).toEqual([]);
    expect(staked.positions.map((p) => p.positionType)).toEqual(["lp"]);

    const empty = await detectDefiPositionsViaDirectRead(USER, "testnet", {
      rpc: mockRpc(phoenixLedger(phoenixShares(0n), ...bonding)),
      registryEntries: phoenixStakeRegistry(),
    });
    expect(empty.unrecognizedPositions).toEqual([]);
    expect(empty.positions).toEqual([]);
  }
});

test("Phoenix: a bonding entry that does not decode is flagged, never read as no stake", async () => {
  const malformed = contractDataEntry(
    PHOENIX_STAKE,
    new Address(USER).toScVal(),
    structVal({ stakes: i128Val(5n) })
  );
  const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc: mockRpc(phoenixLedger(phoenixShares(0n), malformed)),
    registryEntries: phoenixStakeRegistry(),
  });
  expect(result.positions).toEqual([]);
  expect(result.unrecognizedPositions).toEqual([
    expect.objectContaining({ protocol: "phoenix", rawType: "bonding-info-unreadable" }),
  ]);
});

test("Phoenix: a pool whose CONFIG names no stake contract is flagged, its LP shares still reported", async () => {
  const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc: mockRpc([
      contractInstanceEntry(PHOENIX_POOL, PHOENIX_WASM_HASH),
      contractInstanceEntry(PHOENIX_STAKE, PHOENIX_STAKE_WASM_HASH),
      phoenixConfigEntry(undefined, null),
      phoenixShares(5n),
    ]),
    registryEntries: phoenixStakeRegistry(),
  });
  expect(result.positions.map((p) => p.positionType)).toEqual(["lp"]);
  expect(result.unrecognizedPositions).toEqual([
    expect.objectContaining({ protocol: "phoenix", rawType: "stake-contract-unknown" }),
  ]);
});

test("Phoenix: stakes held on a stake contract the registry does not verify are flagged, not decoded", async () => {
  const otherNetwork = phoenixStakeRegistry().map((e) =>
    e.kind === "stake" ? { ...e, network: "mainnet" as const } : e
  );
  for (const registryEntries of [
    phoenixRegistry(),
    otherNetwork,
    phoenixStakeRegistry("4".repeat(64)),
  ]) {
    const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
      rpc: mockRpc(phoenixLedger(phoenixShares(0n), bondingEntry([[7n, 9n]]))),
      registryEntries,
    });
    expect(result.positions).toEqual([]);
    expect(result.unrecognizedPositions).toContainEqual(
      expect.objectContaining({ protocol: "phoenix", rawType: "stake-contract-unregistered" })
    );
  }
});

test("Phoenix: the bonding entry is read in the same call as the share balance, under the bare account key", async () => {
  const keysSeen: xdr.LedgerKey[][] = [];
  const inner = mockRpc(phoenixLedger(phoenixShares(0n), bondingEntry([[7n, 9n]])));
  const { rpc, sizes } = tracingRpc({
    getLedgerEntries: async (...keys: xdr.LedgerKey[]) => {
      keysSeen.push(keys);
      return inner.getLedgerEntries(...keys);
    },
  } as unknown as TracedRpc);
  const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc,
    registryEntries: phoenixStakeRegistry(),
  });
  expect(result.positions).toHaveLength(1);
  // The instance read for pool and stake contract, then the pool's CONFIG, then one batch.
  expect(sizes).toEqual([2, 1, 2]);
  expect(keysSeen[2]!.map((k) => k.toXdr("base64"))).toContain(BARE_BONDING_KEY);
});

test("Phoenix: a failing stake read rejects the account read rather than reporting no stake", async () => {
  const inner = mockRpc(phoenixLedger(phoenixShares(0n), bondingEntry([[7n, 9n]])));
  const rpc = {
    getLedgerEntries: async (...keys: xdr.LedgerKey[]) => {
      if (keys.some((k) => k.toXdr("base64") === BARE_BONDING_KEY)) throw new Error("boom");
      return inner.getLedgerEntries(...keys);
    },
  } as unknown as TracedRpc;
  await expect(
    detectDefiPositionsViaDirectRead(USER, "testnet", {
      rpc,
      registryEntries: phoenixStakeRegistry(),
    })
  ).rejects.toThrow("boom");
});

test("FxDAO: a denomination named only by its VaultsInfo is still probed, and reported without a debt token", async () => {
  const [, vaultsInfo] = fxdaoDenominationStorage(symbolVal("usd"));
  const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc: mockRpc([
      contractInstanceEntry(FXDAO_VAULTS, FXDAO_WASM_HASH, [vaultsInfo!]),
      fxdaoVault(FXDAO_VAULTS, "usd", 10n, 4n),
    ]),
    registryEntries: fxdaoEntries(),
  });
  expect(result.positions).toHaveLength(1);
  expect(result.positions[0]).toMatchObject({ denomination: "usd", debtAmount: "4" });
  expect(result.positions[0]).not.toHaveProperty("debtToken");
});

test("FxDAO: a vault position carries the stablecoin its vault registers for the denomination", async () => {
  const read = async (stable: xdr.ScVal) =>
    (
      await detectDefiPositionsViaDirectRead(USER, "testnet", {
        rpc: mockRpc([
          contractInstanceEntry(
            FXDAO_VAULTS,
            FXDAO_WASM_HASH,
            fxdaoDenominationStorage(symbolVal("usd"), stable)
          ),
          fxdaoVault(FXDAO_VAULTS, "usd", 10n, 4n),
        ]),
        registryEntries: fxdaoEntries(),
      })
    ).positions;

  expect(await read(new Address(FXDAO_STABLE).toScVal())).toEqual([
    {
      protocol: "fxdao",
      positionType: "cdp",
      contractAddress: FXDAO_VAULTS,
      wasmHash: FXDAO_WASM_HASH,
      denomination: "usd",
      collateralAmount: "10",
      debtAmount: "4",
      debtToken: FXDAO_STABLE,
      usdValue: null,
    },
  ]);
  // An account is never the stablecoin: the position is still reported, without a debt token.
  const [withoutToken] = await read(addressVal(USER));
  expect(withoutToken).toBeDefined();
  expect(withoutToken).not.toHaveProperty("debtToken");
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
  expect(Math.max(...sizes)).toBeLessThanOrEqual(150);
  // 1 registry verification + 1 factory instance + 2 index chunks + 2 balance chunks + 1 held-pair chunk.
  expect(sizes.length).toBe(7);
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
const AQ_ROUTER_HASH = "840aa116e14f3f01578933c76c472b372a65e8a2ecff3a8b8d69b2df0a114108";
const AQ_CONSTANT_HASH = "70476939e1ce8b4f7d6898d7a1403bd0752ba0535ad6c4aea3c4b500ad4715e0";
const AQ_STABLE_HASH = "278f6f02d18ea4fcee8ecb208a5e2ea5ad8e81ff2a1015574161d44c6f325558";
const AQ_CONCENTRATED_HASH = "b3092d4560a24fd45c143295655846da66d49abad34d15f9613241b6256689d5";
const AQ_OWNER = "CDD3G6M2JSJLXBYLY4N6WLWVU2LB5UGPSKFO5ZV4M6BMYQY555Q6FA46";
const AQ_OWNER_HASH = "758bdb9683495f07a96c1dbdd4f7775c45205691eea317d22b97aeb82fa4960f";
const AQ_TAGS = {
  constant: "amm.constant",
  stable: "amm.stable",
  concentrated: "amm.concentrated",
} as const;
const AQ_POOL_CONSTANT = "CDLYWB5CCSNOEXPGHSKYO4FW3R4XFQVI2HR2QC735YDVCSEQJABQDFXI";
const AQ_POOL_STABLE = "CDDLEQE6CPQGIK3RU4MK5CX2IAWN6CXWNJ2C3VOXV4FOVF3BBQFVZDIC";
const AQ_POOL_CONCENTRATED = "CCS6EFFKPQWG5SKMMYL4UQIXVYVDNIXAPHKHUM7IGJVN7QIAWXD2L7TO";
const AQ_SHARE_CONSTANT = "CAN7DMIQH7FGKNYCUQMWECJJ74EKN5JATVVUOVTXOWLQGZCWAFWANG5P";
const AQ_SHARE_STABLE = "CATORI2GO3MB5S6JJCXCTDHMTNXRYR2YV7GU5EWQQ4KS5ANWVACUKLBE";
const AQ_TOKEN_A = "CAZRY5GSFBFXD7H6GAFBA5YGYQTDXU4QKWKMYFWBAZFUCURN3WKX6LF5";
const AQ_TOKEN_B = "CBL6KD2LFMLAUKFFWNNXWOXFN73GAXLEA4WMJRLQ5L76DMYTM3KWQVJN";

function aquariusRegistry(): ContractRegistryEntry[] {
  const pool = (
    address: string,
    wasmHash: string,
    version: string,
    executableTag: string
  ): ContractRegistryEntry =>
    registryEntry({
      protocol: "aquarius",
      kind: "pool",
      address,
      wasmHash,
      version,
      executableOwner: AQ_OWNER,
      executableTag,
    });
  return [
    registryEntry({
      protocol: "aquarius",
      kind: "router",
      address: AQ_ROUTER,
      wasmHash: AQ_ROUTER_HASH,
      version: "v1",
    }),
    pool(AQ_POOL_CONSTANT, AQ_CONSTANT_HASH, "constant_product", AQ_TAGS.constant),
    pool(AQ_POOL_STABLE, AQ_STABLE_HASH, "stable", AQ_TAGS.stable),
    pool(AQ_POOL_CONCENTRATED, AQ_CONCENTRATED_HASH, "concentrated", AQ_TAGS.concentrated),
  ];
}

const u128 = (n: number): xdr.ScVal =>
  xdr.ScVal.scvU128(new xdr.Uint128Parts({ hi: 0n, lo: BigInt(n) }));
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

/** A pool as live testnet runs it: its instance names a tag on the release owner, whose entry
 *  holds the code hash. */
function releasePool(
  pool: string,
  tag: string,
  wasmHash: string,
  storage: Array<[xdr.ScVal, xdr.ScVal]>
) {
  return [
    externalRefInstanceEntry(pool, AQ_OWNER, tag, storage),
    executableTagEntry(AQ_OWNER, tag, wasmHash),
  ];
}

function constantPool(
  pool: string,
  share: string,
  shares: bigint | null,
  wasmHash = AQ_CONSTANT_HASH
) {
  const out = [
    ...releasePool(pool, AQ_TAGS.constant, wasmHash, [
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
    ...releasePool(pool, AQ_TAGS.stable, AQ_STABLE_HASH, [
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
      ...releasePool(AQ_POOL_CONCENTRATED, AQ_TAGS.concentrated, AQ_CONCENTRATED_HASH, [
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
      ...releasePool(AQ_POOL_CONSTANT, AQ_TAGS.constant, AQ_CONSTANT_HASH, [
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

// ─── CAP-85 shared releases: owner and tag are part of a pool's code ─────────

/** Shares in the constant-product pool whose code comes from `entries`, as the read flags them. */
async function heldPoolRead(poolEntries: ReturnType<typeof contractInstanceEntry>[]) {
  return detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc: mockRpc([
      ...aquariusRouterEntries([{ tokens: [AQ_TOKEN_A, AQ_TOKEN_B], pools: [AQ_POOL_CONSTANT] }]),
      ...poolEntries,
      contractDataEntry(AQ_SHARE_CONSTANT, variantVal("Balance", addressVal(USER)), i128Val(9n)),
    ]),
    registryEntries: aquariusRegistry(),
  });
}

const constantStorage = (): Array<[xdr.ScVal, xdr.ScVal]> => [
  [sym("TokenA"), addrVal(AQ_TOKEN_A)],
  [sym("TokenB"), addrVal(AQ_TOKEN_B)],
  [sym("TokenShare"), addrVal(AQ_SHARE_CONSTANT)],
];

test("Aquarius: a pool on the pinned owner's pinned tag naming the pinned hash is read", async () => {
  const result = await heldPoolRead(
    releasePool(AQ_POOL_CONSTANT, AQ_TAGS.constant, AQ_CONSTANT_HASH, constantStorage())
  );
  expect(result.unrecognizedPositions).toEqual([]);
  expect(result.positions.map((p) => p.wasmHash)).toEqual([AQ_CONSTANT_HASH]);
});

test("Aquarius: a pool whose code comes from another owner, another tag, or a missing tag entry is flagged, not decoded", async () => {
  const otherOwner = Address.contract(Buffer.alloc(32, 0x44)).toString();
  const cases = [
    [
      externalRefInstanceEntry(AQ_POOL_CONSTANT, otherOwner, AQ_TAGS.constant, constantStorage()),
      executableTagEntry(otherOwner, AQ_TAGS.constant, AQ_CONSTANT_HASH),
    ],
    [
      externalRefInstanceEntry(AQ_POOL_CONSTANT, AQ_OWNER, AQ_TAGS.stable, constantStorage()),
      executableTagEntry(AQ_OWNER, AQ_TAGS.stable, AQ_CONSTANT_HASH),
    ],
    [externalRefInstanceEntry(AQ_POOL_CONSTANT, AQ_OWNER, AQ_TAGS.constant, constantStorage())],
    releasePool(AQ_POOL_CONSTANT, AQ_TAGS.constant, "7".repeat(64), constantStorage()),
  ];
  for (const entries of cases) {
    const result = await heldPoolRead(entries);
    expect(result.positions).toEqual([]);
    expect(result.unrecognizedPositions.map((u) => u.rawType)).toEqual(["pool-code-unknown"]);
  }
});

test("Aquarius: the pinned hash carried by a plain Wasm pool is not the pinned release, and is flagged", async () => {
  const result = await heldPoolRead([
    contractInstanceEntry(AQ_POOL_CONSTANT, AQ_CONSTANT_HASH, constantStorage()),
  ]);
  expect(result.positions).toEqual([]);
  expect(result.unrecognizedPositions.map((u) => u.rawType)).toEqual(["pool-code-unknown"]);
});

test("Aquarius: every pool's tag is resolved in one batched read, deduplicated across pools", async () => {
  const calls: string[][] = [];
  const inner = mockRpc([
    ...aquariusRouterEntries([
      {
        tokens: [AQ_TOKEN_A, AQ_TOKEN_B],
        pools: [AQ_POOL_CONSTANT, AQ_POOL_STABLE, AQ_POOL_CONCENTRATED],
      },
    ]),
    ...constantPool(AQ_POOL_CONSTANT, AQ_SHARE_CONSTANT, 0n),
    ...releasePool(AQ_POOL_STABLE, AQ_TAGS.constant, AQ_CONSTANT_HASH, constantStorage()),
    ...releasePool(AQ_POOL_CONCENTRATED, AQ_TAGS.concentrated, AQ_CONCENTRATED_HASH, []),
  ]);
  const rpc = {
    getLedgerEntries: async (...keys: xdr.LedgerKey[]) => {
      calls.push(keys.map((k) => k.toXdr("base64")));
      return inner.getLedgerEntries(...keys);
    },
  } as unknown as typeof inner;
  await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc,
    registryEntries: aquariusRegistry(),
  });
  const tagKey = (tag: string) =>
    executableTagEntry(AQ_OWNER, tag, AQ_CONSTANT_HASH).key.toXdr("base64");
  const tagCalls = calls.filter((c) => c.includes(tagKey(AQ_TAGS.constant)));
  expect(tagCalls).toHaveLength(1);
  expect([...tagCalls[0]!].sort()).toEqual(
    [tagKey(AQ_TAGS.constant), tagKey(AQ_TAGS.concentrated)].sort()
  );
});

// ─── registry verification of code identity ──────────────────────────────────

function ownerEntry(over: Partial<ContractRegistryEntry> = {}): ContractRegistryEntry {
  return registryEntry({
    protocol: "aquarius",
    kind: "executable-owner",
    address: AQ_OWNER,
    wasmHash: AQ_OWNER_HASH,
    version: "v1",
    ...over,
  });
}

test("the release owner is verified on every read and adds no positions of its own", async () => {
  const ok = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc: mockRpc([contractInstanceEntry(AQ_OWNER, AQ_OWNER_HASH)]),
    registryEntries: [ownerEntry()],
  });
  expect(ok.positions).toEqual([]);
  expect(ok.unrecognizedPositions).toEqual([]);

  const upgraded = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc: mockRpc([contractInstanceEntry(AQ_OWNER, "5".repeat(64))]),
    registryEntries: [ownerEntry()],
  });
  expect(upgraded.unrecognizedPositions.map((u) => u.rawType)).toEqual(["wasmhash-mismatch"]);

  const gone = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc: mockRpc([]),
    registryEntries: [ownerEntry()],
  });
  expect(gone.unrecognizedPositions.map((u) => u.rawType)).toEqual(["registry-entry-unresolvable"]);
});

test("a probed entry pinned to a reference refuses Wasm, another reference, or the reference naming other code", async () => {
  const pinned = ownerEntry({ executableOwner: AQ_OWNER, executableTag: "release.self" });
  const otherOwner = Address.contract(Buffer.alloc(32, 0x55)).toString();
  const read = (entries: ReturnType<typeof contractInstanceEntry>[]) =>
    detectDefiPositionsViaDirectRead(USER, "testnet", {
      rpc: mockRpc(entries),
      registryEntries: [pinned],
    }).then((r) => r.unrecognizedPositions.map((u) => u.rawType));

  expect(
    await read([
      externalRefInstanceEntry(AQ_OWNER, AQ_OWNER, "release.self"),
      executableTagEntry(AQ_OWNER, "release.self", AQ_OWNER_HASH),
    ])
  ).toEqual([]);
  expect(await read([contractInstanceEntry(AQ_OWNER, AQ_OWNER_HASH)])).toEqual([
    "executable-reference-mismatch",
  ]);
  expect(
    await read([
      externalRefInstanceEntry(AQ_OWNER, otherOwner, "release.self"),
      executableTagEntry(otherOwner, "release.self", AQ_OWNER_HASH),
    ])
  ).toEqual(["executable-reference-mismatch"]);
  expect(
    await read([
      externalRefInstanceEntry(AQ_OWNER, AQ_OWNER, "release.other"),
      executableTagEntry(AQ_OWNER, "release.other", AQ_OWNER_HASH),
    ])
  ).toEqual(["executable-reference-mismatch"]);
  expect(
    await read([
      externalRefInstanceEntry(AQ_OWNER, AQ_OWNER, "release.self"),
      executableTagEntry(AQ_OWNER, "release.self", "6".repeat(64)),
    ])
  ).toEqual(["wasmhash-mismatch"]);
  expect(await read([externalRefInstanceEntry(AQ_OWNER, AQ_OWNER, "release.self")])).toEqual([
    "registry-entry-unresolvable",
  ]);
});

test("a probed entry that pins no reference refuses an instance that takes its code from one", async () => {
  const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc: mockRpc([
      externalRefInstanceEntry(AQ_OWNER, AQ_OWNER, "release.self"),
      executableTagEntry(AQ_OWNER, "release.self", AQ_OWNER_HASH),
    ]),
    registryEntries: [ownerEntry()],
  });
  expect(result.unrecognizedPositions.map((u) => u.rawType)).toEqual([
    "executable-reference-mismatch",
  ]);
});

// ─── read shape: one verification read, concurrent sweeps ────────────────────

type TracedRpc = ReturnType<typeof mockRpc>;

/** Wraps a mock rpc to record each call's key count and the most calls ever in flight at once,
 *  holding every call open for `delayMs` so concurrency is observable rather than a race. */
function tracingRpc(
  inner: TracedRpc,
  delayMs: (keys: xdr.LedgerKey[]) => number = () => 1
): { rpc: TracedRpc; sizes: number[]; maxInFlight: () => number } {
  const sizes: number[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const rpc = {
    getLedgerEntries: async (...keys: xdr.LedgerKey[]) => {
      sizes.push(keys.length);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, delayMs(keys)));
        return await inner.getLedgerEntries(...keys);
      } finally {
        inFlight -= 1;
      }
    },
  } as unknown as TracedRpc;
  return { rpc, sizes, maxInFlight: () => maxInFlight };
}

const contractOf = (key: xdr.LedgerKey): string => {
  if (key.type !== "contractData") throw new Error("expected a contract data key");
  return Address.fromScAddress(key.contractData.contract).toString();
};

test("every registered contract is verified in one ledger read, not one round trip per entry", async () => {
  const entries = [
    registryEntry(),
    registryEntry({
      address: FXDAO_VAULTS,
      protocol: "fxdao",
      kind: "vault",
      wasmHash: FXDAO_WASM_HASH,
    }),
    registryEntry({
      address: PHOENIX_POOL,
      protocol: "phoenix",
      kind: "pool",
      wasmHash: PHOENIX_WASM_HASH,
    }),
  ];
  const { rpc, sizes } = tracingRpc(
    mockRpc([
      contractInstanceEntry(BLEND_POOL, BLEND_WASM_HASH),
      contractInstanceEntry(
        FXDAO_VAULTS,
        FXDAO_WASM_HASH,
        fxdaoDenominationStorage(symbolVal("usd"))
      ),
      contractInstanceEntry(PHOENIX_POOL, PHOENIX_WASM_HASH),
    ])
  );
  const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc,
    registryEntries: entries,
  });
  expect(result.unrecognizedPositions).toEqual([]);
  // One call carrying all three instance keys, then one read per verified contract.
  expect(sizes[0]).toBe(3);
  expect(sizes).toHaveLength(4);
});

test("protocol reads run at the same time, and positions still come back in registry order", async () => {
  const entries = [
    registryEntry(),
    registryEntry({
      address: PHOENIX_POOL,
      protocol: "phoenix",
      kind: "pool",
      wasmHash: PHOENIX_WASM_HASH,
    }),
  ];
  const inner = mockRpc([
    contractInstanceEntry(BLEND_POOL, BLEND_WASM_HASH),
    contractDataEntry(BLEND_POOL, symbolVal("ResList"), addressListVal([ASSET_A])),
    contractDataEntry(
      BLEND_POOL,
      variantVal("Positions", addressVal(USER)),
      structVal({
        supply: u32MapVal([[0, 5_0000000n]]),
        collateral: u32MapVal([]),
        liabilities: u32MapVal([]),
      })
    ),
    contractInstanceEntry(PHOENIX_POOL, PHOENIX_WASM_HASH),
    phoenixConfigEntry(),
    contractDataEntry(PHOENIX_SHARE, variantVal("Balance", addressVal(USER)), i128Val(7_0000000n)),
  ]);
  // Blend's read is held open longer than Phoenix's, so completion order is the reverse of
  // registry order; the result must not depend on which finished first.
  const { rpc, maxInFlight } = tracingRpc(inner, (keys) =>
    contractOf(keys[0]!) === BLEND_POOL ? 30 : 1
  );
  const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc,
    registryEntries: entries,
  });
  expect(result.unrecognizedPositions).toEqual([]);
  expect(result.positions.map((p) => p.protocol)).toEqual(["blend", "phoenix"]);
  expect(maxInFlight()).toBeGreaterThanOrEqual(2);
});

const randomContract = (): string =>
  StrKey.encodeContract(StrKey.decodeEd25519PublicKey(Keypair.random().publicKey()));

/** More chunks than the concurrency limit, so the upper bound below is exercised, not vacuous. */
const MANY_PAIRS = LEDGER_KEYS_PER_CALL * (LEDGER_READ_CONCURRENCY + 2);

test("a chunked sweep issues its chunks together, bounded by the read concurrency and the RPC's 200-key cap", async () => {
  const pairs = Array.from({ length: MANY_PAIRS }, randomContract);
  const held = pairs[MANY_PAIRS - 1]!;
  const inner = mockRpc([...factoryEntries(pairs), ...pairEntries(held, 1n)]);
  const { rpc, sizes, maxInFlight } = tracingRpc(inner, () => 5);
  const result = await detectDefiPositionsViaDirectRead(USER, "testnet", {
    rpc,
    registryEntries: SOROSWAP_REGISTRY(),
  });
  expect(result.positions.map((p) => p.contractAddress)).toEqual([held]);
  expect(LEDGER_KEYS_PER_CALL).toBeLessThanOrEqual(200);
  expect(Math.max(...sizes)).toBeLessThanOrEqual(LEDGER_KEYS_PER_CALL);
  expect(maxInFlight()).toBeGreaterThanOrEqual(2);
  expect(maxInFlight()).toBeLessThanOrEqual(LEDGER_READ_CONCURRENCY);
});

test("two detections against the same RPC server share one concurrency budget", async () => {
  const pairs = Array.from({ length: MANY_PAIRS }, randomContract);
  const inner = mockRpc([...factoryEntries(pairs), ...pairEntries(pairs[0]!, 1n)]);
  const { rpc, maxInFlight } = tracingRpc(inner, () => 5);
  const run = () =>
    detectDefiPositionsViaDirectRead(USER, "testnet", {
      rpc,
      registryEntries: SOROSWAP_REGISTRY(),
    });
  const [a, b] = await Promise.all([run(), run()]);
  expect(a.positions).toHaveLength(1);
  expect(b.positions).toHaveLength(1);
  expect(maxInFlight()).toBeGreaterThanOrEqual(2);
  expect(maxInFlight()).toBeLessThanOrEqual(LEDGER_READ_CONCURRENCY);
});

test("once one read fails, the detection rejects and its queued reads never reach the RPC", async () => {
  const pairs = Array.from({ length: MANY_PAIRS }, randomContract);
  const inner = mockRpc([...factoryEntries(pairs), ...pairEntries(pairs[0]!, 1n)]);
  let thrown = false;
  const failingOnce = {
    getLedgerEntries: async (...keys: xdr.LedgerKey[]) => {
      // The first full-size chunk (an index chunk of the factory sweep) fails, like a 429 would.
      if (!thrown && keys.length === LEDGER_KEYS_PER_CALL) {
        thrown = true;
        throw new Error("boom");
      }
      return inner.getLedgerEntries(...keys);
    },
  } as unknown as TracedRpc;
  const { rpc, sizes } = tracingRpc(failingOnce, () => 5);
  await expect(
    detectDefiPositionsViaDirectRead(USER, "testnet", { rpc, registryEntries: SOROSWAP_REGISTRY() })
  ).rejects.toThrow("boom");
  // 1 registry verification + 1 factory instance + the chunks already in flight when one failed.
  // The chunks still queued behind the limit were dropped, not sent.
  expect(sizes.length).toBeLessThanOrEqual(2 + LEDGER_READ_CONCURRENCY);
});

test("enumerateAquariusPools bounds its own concurrency when handed a raw reader", async () => {
  const setCount = LEDGER_KEYS_PER_CALL * (LEDGER_READ_CONCURRENCY + 2);
  const sets = Array.from({ length: setCount }, () => ({
    tokens: [randomContract(), randomContract()],
    pools: [randomContract()],
  }));
  const { rpc, maxInFlight } = tracingRpc(mockRpc(aquariusRouterEntries(sets)), () => 5);
  const flags: string[] = [];
  const views = await enumerateAquariusPools(rpc, aquariusRegistry()[0]!, (rawType) => {
    flags.push(rawType);
  });
  // Every pool lacks an instance here; the sweep still completes and says so.
  expect(views).toEqual([]);
  expect(flags).toEqual(["pool-unreadable"]);
  expect(maxInFlight()).toBeGreaterThanOrEqual(2);
  expect(maxInFlight()).toBeLessThanOrEqual(LEDGER_READ_CONCURRENCY);
});
