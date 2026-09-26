/**
 * The FxDAO exit adapter under the shared invariant harness, plus what is specific to it: the
 * single full `pay_debt` step (never a separate collateral withdrawal), the linked-list `prev_key`
 * walk across a chain of other vaults, the pre-repay undercollateralization gate, and the
 * `VaultKey`/`OptionalVaultKey` argument encoding `pay_debt` actually needs.
 */
import { describe, expect, test } from "bun:test";
import { Asset, xdr } from "@stellar/stellar-sdk";
import type { FxdaoCdpPosition } from "@lumenwipe/types";
import { EXIT_POSITION_GONE, fxdaoExitAdapter, runExitAdapter } from "@/lib/defi-exits";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import {
  createContractRegistryLookup,
  validateContractRegistry,
  type ContractRegistryEntry,
  type ContractRegistryLookup,
} from "@/lib/contract-registry";
import { describeExitAdapterInvariants, harnessContext } from "./fixtures/exit-adapter-harness";
import {
  DENOMINATION,
  FXDAO_VAULT_HASH,
  STABLE_ISSUER,
  VAULT,
  fakeFxdaoRpc,
  randomAccount,
  type FakeFxdaoOptions,
  type FakeVault,
} from "./fixtures/fake-fxdao-vault";

const ACCOUNT = randomAccount();
const TOTAL_COLLATERAL = 1_150_000_000n; // 115 XLM
const TOTAL_DEBT = 100_000_000n; // 100 USDx
const STABLE_ASSET = new Asset(DENOMINATION, STABLE_ISSUER).contractId(NETWORK_PASSPHRASES.testnet);

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
  tokenBalances: { [STABLE_ASSET]: TOTAL_DEBT.toString() },
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
      ctx: { tokenBalances: {} },
      expectCodes: ["fxdao_repay_asset_balance_unknown"],
    },
    {
      name: "the account holds less stablecoin than the debt",
      position,
      rpc: rpc(),
      registry: KNOWN,
      ctx: { tokenBalances: { [STABLE_ASSET]: (TOTAL_DEBT - 1n).toString() } },
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
    { rpc: rpc(over), resolveWasmHash: KNOWN.resolveWasmHash, isRegistryFresh: () => true }
  );
}

function invocationArgs(txXdr: string): xdr.ScVal[] {
  const envelope = xdr.TransactionEnvelope.fromXDR(txXdr, "base64");
  const op = envelope.v1().tx().operations()[0]!;
  return op.body().invokeHostFunctionOp().hostFunction().invokeContract().args();
}

function optionalKeyTag(val: xdr.ScVal): string {
  return val.vec()![0]!.sym().toString();
}

describe("fxdao exit adapter", () => {
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
    expect(args[1]!.switch()).toBe(xdr.ScValType.scvMap());
    // new_prev_key is always None: a full repay always zeroes the vault's sort index.
    expect(optionalKeyTag(args[2]!)).toBe("None");
    expect(args[3]!.switch()).toBe(xdr.ScValType.scvU128());
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

  test("the repay asset resolves through the denomination and the live stable issuer", async () => {
    const result = await run();
    expect(result.plan[0]!.asset).toBe(STABLE_ASSET);
  });
});
