/**
 * The FxDAO exit adapter under the shared invariant harness, plus what is specific to it: the
 * single full `pay_debt` step (never a separate collateral withdrawal), the linked-list `prev_key`
 * walk across a chain of other vaults, the pre-repay undercollateralization gate, and the
 * `VaultKey`/`OptionalVaultKey` argument encoding `pay_debt` actually needs.
 */
import { describe, expect, test } from "bun:test";
import { Asset, StrKey, xdr } from "@stellar/stellar-sdk";
import type { AccountState, FxdaoCdpPosition, SorobanTokensResult } from "@lumenwipe/types";
import { EXIT_POSITION_GONE, fxdaoExitAdapter, runExitAdapter } from "@/lib/defi-exits";
import { buildExitRound, preflightExitTargets } from "@/lib/defi-exits/exit-round";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import {
  createContractRegistryLookup,
  validateContractRegistry,
  type ContractRegistryEntry,
  type ContractRegistryLookup,
} from "@/lib/contract-registry";
import { describeExitAdapterInvariants, harnessContext } from "./fixtures/exit-adapter-harness";
import {
  CURRENCY_CONTRACT,
  DENOMINATION,
  FXDAO_VAULT_HASH,
  STABLE_ISSUER,
  VAULT,
  fakeFxdaoRpc,
  randomAccount,
  type FakeFxdaoOptions,
  type FakeVault,
} from "./fixtures/fake-fxdao-vault";
import { invokeContractArgs, v1TransactionFromXdr } from "../support/v1-transaction";

const ACCOUNT = randomAccount();
const TOTAL_COLLATERAL = 1_150_000_000n; // 115 XLM
const TOTAL_DEBT = 100_000_000n; // 100 USDx
const STABLE_ASSET = CURRENCY_CONTRACT;
/** What a `stable_issuer`-derived classic SAC would compute - kept only to prove it is genuinely
 *  a different address from the real, live `Currency.contract` (see the regression test below). */
const WRONG_STABLE_ISSUER_DERIVED_ASSET = new Asset(DENOMINATION, STABLE_ISSUER).contractId(
  NETWORK_PASSPHRASES.testnet
);

function entry(over: Partial<ContractRegistryEntry>): ContractRegistryEntry {
  return {
    network: "testnet",
    protocol: "fxdao",
    kind: "vault",
    address: VAULT,
    wasmHash: FXDAO_VAULT_HASH,
    version: "v1",
    label: "test",
    verifiedLive: true,
    ...over,
  };
}

function registry(entries: ContractRegistryEntry[]): ContractRegistryLookup {
  return createContractRegistryLookup(
    validateContractRegistry({
      version: "test",
      lastVerified: "2026-09-01",
      validUntil: "2026-12-01",
      source: "fxdao adapter test",
      entries,
    })
  );
}

const KNOWN = registry([entry({})]);

/** Detection overstates on purpose: the harness checks that amounts come from the live read. */
const position: FxdaoCdpPosition = {
  protocol: "fxdao",
  positionType: "cdp",
  contractAddress: VAULT,
  denomination: DENOMINATION,
  collateralAmount: (TOTAL_COLLATERAL * 3n).toString(),
  debtAmount: (TOTAL_DEBT * 3n).toString(),
  usdValue: null,
};

const adapter = fxdaoExitAdapter();

function rpc(over: Partial<FakeFxdaoOptions> = {}) {
  return fakeFxdaoRpc({
    account: ACCOUNT,
    totalCollateral: TOTAL_COLLATERAL,
    totalDebt: TOTAL_DEBT,
    ...over,
  });
}

const ctx = harnessContext({
  account: ACCOUNT,
  sorobanTokenBalances: { [STABLE_ASSET]: TOTAL_DEBT.toString() },
});

describeExitAdapterInvariants("fxdao vault", {
  adapter,
  healthy: {
    position,
    rpc: rpc(),
    registry: KNOWN,
    detectedAmount: position.debtAmount,
    // The harness's generic "detection overstates the live read" check falls back to the position's
    // contract address when a position type (like this CDP) has no dedicated `assetAddress` field -
    // this adapter's own step is keyed by the stablecoin asset instead, so this entry only exists to
    // satisfy that generic meta-check, same idea as an LP position's pool-address-keyed entry.
    liveCeiling: { [STABLE_ASSET]: TOTAL_DEBT.toString(), [VAULT]: "0" },
  },
  simulationFails: { position, rpc: rpc({ simulation: "error" }), registry: KNOWN },
  simulationNeedsRestore: { position, rpc: rpc({ simulation: "restore" }), registry: KNOWN },
  blocked: [
    {
      name: "the vault's contract is registered as a different kind",
      position,
      rpc: rpc(),
      registry: registry([entry({ kind: "pool" })]),
      expectCodes: ["fxdao_contract_not_vault"],
    },
    {
      name: "the vault runs a registered version with no repay entry point",
      position,
      rpc: rpc(),
      registry: registry([entry({ version: "wind-down" })]),
      expectCodes: ["fxdao_vault_no_repay"],
    },
    {
      name: "the account no longer holds an open vault",
      position,
      rpc: rpc({ ownVaultMissing: true }),
      registry: KNOWN,
      expectCodes: [EXIT_POSITION_GONE],
    },
    {
      name: "the vault's core state cannot be read",
      position,
      rpc: rpc({ coreStateMissing: true }),
      registry: KNOWN,
      expectCodes: ["fxdao_vault_unreadable"],
    },
    {
      name: "the denomination's registered currency cannot be read",
      position,
      rpc: rpc({ currencyMissing: true }),
      registry: KNOWN,
      expectCodes: ["fxdao_vault_unreadable"],
    },
    {
      name: "the oracle has no live price",
      position,
      rpc: rpc({ price: null }),
      registry: KNOWN,
      expectCodes: ["fxdao_price_unreadable"],
    },
    {
      name: "the vault is below the minimum collateral ratio",
      position,
      rpc: rpc({ ratio: 1_050_000_000n }), // 105% < the fixture's 110% min_col_rate
      registry: KNOWN,
      expectCodes: ["fxdao_vault_undercollateralized"],
    },
    {
      name: "the account has no stablecoin to repay with",
      position,
      rpc: rpc(),
      registry: KNOWN,
      ctx: { sorobanTokenBalances: {} },
      expectCodes: ["fxdao_repay_asset_balance_unknown"],
    },
    {
      name: "the account's stablecoin balance is not a base-unit amount",
      position,
      rpc: rpc(),
      registry: KNOWN,
      ctx: { sorobanTokenBalances: { [STABLE_ASSET]: "100.5" } },
      expectCodes: ["fxdao_repay_asset_balance_unknown"],
    },
    {
      name: "the account holds less stablecoin than the debt",
      position,
      rpc: rpc(),
      registry: KNOWN,
      ctx: { sorobanTokenBalances: { [STABLE_ASSET]: (TOTAL_DEBT - 1n).toString() } },
      expectCodes: ["fxdao_repay_asset_missing"],
    },
  ],
  ctx,
});

async function run(over: Partial<FakeFxdaoOptions> = {}, ctxOver: Partial<typeof ctx> = {}) {
  return runExitAdapter(
    adapter,
    position,
    { ...ctx, ...ctxOver },
    { rpc: rpc(over), resolveCode: KNOWN.resolveCode, isRegistryFresh: () => true }
  );
}

function invocationArgs(txXdr: string): xdr.ScVal[] {
  return invokeContractArgs(v1TransactionFromXdr(txXdr).operations[0]!).args;
}

function optionalKeyTag(val: xdr.ScVal): string {
  if (val.type !== "scvVec") throw new Error("expected a vec");
  const tag = val.vec?.[0];
  if (tag?.type !== "scvSymbol") throw new Error("expected a symbol tag");
  return tag.sym.toString();
}

describe("fxdao exit adapter", () => {
  test("a vault on any version but the verified one is refused before its state is read, and may be left behind", async () => {
    const ledger = rpc();
    let reads = 0;
    let simulations = 0;
    const counting = {
      ...ledger,
      getLedgerEntries: (...keys: Parameters<typeof ledger.getLedgerEntries>) => {
        reads++;
        return ledger.getLedgerEntries(...keys);
      },
      simulateTransaction: (...args: Parameters<typeof ledger.simulateTransaction>) => {
        simulations++;
        return ledger.simulateTransaction(...args);
      },
    };
    const windDown = registry([entry({ version: "wind-down" })]);
    const result = await runExitAdapter(adapter, position, ctx, {
      rpc: counting,
      resolveCode: windDown.resolveCode,
      isRegistryFresh: () => true,
    });
    expect(result.next).toBeNull();
    expect(result.blockers.map((b) => b.code)).toEqual(["fxdao_vault_no_repay"]);
    expect(result.blockers[0]!.message).toContain("no repay entry point");
    expect(result.leaveEligible).toBe(true);
    // Only the runner's own code-hash read: the adapter reads nothing against unverified code.
    expect(reads).toBe(1);
    expect(simulations).toBe(0);
  });

  test("plans one repay of the full debt, never a separate withdrawal step", async () => {
    const result = await run();
    expect(result.blockers).toEqual([]);
    expect(result.plan.map((s) => s.kind)).toEqual(["repay"]);
    expect(result.plan[0]).toMatchObject({
      contract: VAULT,
      function: "pay_debt",
      asset: STABLE_ASSET,
      amount: TOTAL_DEBT.toString(),
      ceiling: TOTAL_DEBT.toString(),
      minReceived: [],
    });
  });

  test("pay_debt is called with prev_key/vault_key/new_prev_key/amount, new_prev_key always None", async () => {
    const result = await run();
    if (!result.next) throw new Error("expected a built step");
    const args = invocationArgs(result.next.simulation.txXdr);
    expect(args).toHaveLength(4);
    // prev_key: no preceding vaults in the default fixture, so our vault is the lowest.
    expect(optionalKeyTag(args[0]!)).toBe("None");
    expect(args[1]!.type).toBe("scvMap");
    // new_prev_key is always None: a full repay always zeroes the vault's sort index.
    expect(optionalKeyTag(args[2]!)).toBe("None");
    expect(args[3]!.type).toBe("scvU128");
  });

  test("walks a chain of other vaults to find the correct prev_key", async () => {
    const neighbor: FakeVault = {
      account: randomAccount(),
      denomination: DENOMINATION,
      index: 5_000_000_000n,
      nextKey: null,
      totalCollateral: 500_000_000n,
      totalDebt: 100_000_000n,
    };
    const result = await run({ precedingVaults: [neighbor] });
    expect(result.blockers).toEqual([]);
    if (!result.next) throw new Error("expected a built step");
    const args = invocationArgs(result.next.simulation.txXdr);
    expect(optionalKeyTag(args[0]!)).toBe("Some");
  });

  test("a vault with debt already at zero is reported as already gone", async () => {
    const result = await run({ totalDebt: 0n });
    expect(result.next).toBeNull();
    expect(result.blockers.map((b) => b.code)).toEqual([EXIT_POSITION_GONE]);
  });

  test("the repay asset is the vault's live Currency.contract, never a stable-issuer-derived SAC", async () => {
    const result = await run();
    expect(result.plan[0]!.asset).toBe(CURRENCY_CONTRACT);
    // Regression guard: a real reference deployment proved these two addresses differ, so a plan
    // that accidentally fell back to the classic-asset derivation would spend the wrong token.
    expect(result.plan[0]!.asset).not.toBe(WRONG_STABLE_ISSUER_DERIVED_ASSET);
  });
});

describe("the exit round repays from the account's ledger-confirmed Soroban token balance", () => {
  const OTHER_TOKEN = StrKey.encodeContract(Buffer.alloc(32, 14));

  function sorobanTokens(
    tokens: Array<{ contract: string; balance: string }>,
    unreadable: string[] = []
  ): SorobanTokensResult {
    return {
      tokens: tokens.map((t) => ({ ...t, symbol: "USDx", decimals: 7, sources: ["positions"] })),
      unreadable,
      // The explorer did not answer: the balance below is still the ledger's `balance()` read.
      coverage: [
        { source: "explorer", status: "failed" },
        { source: "positions", status: "ok" },
      ],
      eventsScanned: null,
      warnings: [],
    };
  }

  function accountWith(
    tokens: SorobanTokensResult | undefined,
    held: FxdaoCdpPosition = position
  ): AccountState {
    return {
      address: ACCOUNT,
      network: "testnet",
      sequence: "100",
      nativeBalanceLumens: "50.0000000",
      dataEntries: [],
      signers: [{ key: ACCOUNT, weight: 1, type: "ed25519_public_key" }],
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
      defiPositions: { ...emptyDefiPositionsResult(ACCOUNT), positions: [held] },
      defiPositionsWarnings: [],
      sorobanTokens: tokens,
    };
  }

  const deps = {
    rpc: rpc(),
    runExitAdapter: ((a, p, c, d) =>
      runExitAdapter(a, p, c, {
        ...d,
        resolveCode: KNOWN.resolveCode,
        isRegistryFresh: () => true,
      })) as typeof runExitAdapter,
  };

  /** The plan's preflight builds the same context the round does and keeps the adapter's code. */
  async function refusal(state: AccountState): Promise<string | undefined> {
    return (await preflightExitTargets(state, "testnet", deps)).get(VAULT)?.code;
  }

  test("a sufficient balance of the vault's Wasm stablecoin builds the full repay", async () => {
    const state = accountWith(
      sorobanTokens([{ contract: CURRENCY_CONTRACT, balance: TOTAL_DEBT.toString() }])
    );
    expect(await refusal(state)).toBeUndefined();
    const built = await buildExitRound(state, "testnet", "100", 1000, deps);
    if (!built) throw new Error("expected a round");
    const op = built.transaction.intent.operations[0]!;
    if (op.type !== "invoke_host_function") throw new Error("expected an invocation intent");
    expect(op.contract).toBe(VAULT);
    expect(op.function).toBe("pay_debt");
  });

  test("a short balance refuses as missing", async () => {
    const state = accountWith(
      sorobanTokens([{ contract: CURRENCY_CONTRACT, balance: (TOTAL_DEBT - 1n).toString() }])
    );
    expect(await refusal(state)).toBe("fxdao_repay_asset_missing");
  });

  test("an unread balance refuses as unknown", async () => {
    expect(await refusal(accountWith(sorobanTokens([], [CURRENCY_CONTRACT])))).toBe(
      "fxdao_repay_asset_balance_unknown"
    );
    expect(await refusal(accountWith(undefined))).toBe("fxdao_repay_asset_balance_unknown");
  });

  test("only a balance under the vault's live currency counts, never the position's debtToken", async () => {
    const state = accountWith(
      sorobanTokens([{ contract: OTHER_TOKEN, balance: (TOTAL_DEBT * 10n).toString() }]),
      { ...position, debtToken: OTHER_TOKEN }
    );
    expect(await refusal(state)).toBe("fxdao_repay_asset_balance_unknown");
  });
});
