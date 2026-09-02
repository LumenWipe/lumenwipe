/**
 * The Soroswap exit adapter under the shared invariant harness, plus what is specific to a pair:
 * floors from the account's share of both reserves, the trustline prerequisite for classic assets,
 * and the router call the step becomes.
 */
import { describe, expect, test } from "bun:test";
import { Address, scValToNative, xdr } from "@stellar/stellar-sdk";
import type { SoroswapLpPosition } from "@lumenwipe/types";
import {
  EXIT_POSITION_GONE,
  defaultSoroswapDeps,
  runExitAdapter,
  soroswapExitAdapter,
} from "@/lib/defi-exits";
import { isqrt, protocolFeeShares } from "@/lib/defi-exits/soroswap";
import {
  createContractRegistryLookup,
  validateContractRegistry,
  type ContractRegistryEntry,
  type ContractRegistryLookup,
} from "@/lib/contract-registry";
import { describeExitAdapterInvariants, harnessContext } from "./fixtures/exit-adapter-harness";
import {
  FACTORY,
  PAIR,
  ROUTER,
  SOROBAN_TOKEN,
  SOROSWAP_PAIR_HASH,
  SOROSWAP_ROUTER_HASH,
  USDC_SAC,
  XLM_SAC,
  fakeSoroswapRpc,
  randomAccount,
  type FakePairOptions,
} from "./fixtures/fake-soroswap-pair";

const ACCOUNT = randomAccount();
const SHARES = 100_000_000n; // 10 LP tokens of a 100-token supply: 10% of each reserve
const RESERVE_0 = 1_000_000_000n; // 100 XLM
const RESERVE_1 = 2_000_000_000n; // 200 USDC
const TOTAL_SUPPLY = 1_000_000_000n;

function entry(over: Partial<ContractRegistryEntry>): ContractRegistryEntry {
  return {
    network: "testnet",
    protocol: "soroswap",
    kind: "pair",
    address: PAIR,
    wasmHash: SOROSWAP_PAIR_HASH,
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
      source: "soroswap adapter test",
      entries,
    })
  );
}

const KNOWN = registry([
  entry({}),
  entry({ kind: "router", address: ROUTER, wasmHash: SOROSWAP_ROUTER_HASH }),
]);

/** Detection overstates on purpose: the harness checks that amounts come from the live read. */
const position: SoroswapLpPosition = {
  protocol: "soroswap",
  positionType: "lp",
  contractAddress: PAIR,
  shareAmount: (SHARES * 3n).toString(),
  usdValue: null,
  tokens: [XLM_SAC, USDC_SAC],
};

const adapter = soroswapExitAdapter({ routerFor: () => ROUTER, factoryFor: () => FACTORY });

function rpc(over: Partial<FakePairOptions> = {}) {
  return fakeSoroswapRpc({
    account: ACCOUNT,
    reserve0: RESERVE_0,
    reserve1: RESERVE_1,
    totalSupply: TOTAL_SUPPLY,
    shares: SHARES,
    ...over,
  });
}

// The account holds a USDC trustline (its SAC appears in tokenBalances), so the withdrawal can
// pay USDC out; XLM never needs one.
const ctx = harnessContext({
  account: ACCOUNT,
  tokenBalances: { [XLM_SAC]: "50000000", [USDC_SAC]: "0" },
});

describeExitAdapterInvariants("soroswap pair", {
  adapter,
  healthy: {
    position,
    rpc: rpc(),
    registry: KNOWN,
    detectedAmount: position.shareAmount,
    liveCeiling: { [PAIR]: SHARES.toString() },
  },
  simulationFails: { position, rpc: rpc({ simulation: "error" }), registry: KNOWN },
  simulationNeedsRestore: { position, rpc: rpc({ simulation: "restore" }), registry: KNOWN },
  blocked: [
    {
      name: "the pair's code is not the registry's pair code",
      position,
      rpc: rpc({ pairHash: "1".repeat(64) }),
      registry: KNOWN,
      expectCodes: ["exit_unknown_contract_version"],
    },
    {
      name: "the router is not vouched for, even though the pair is",
      position,
      rpc: rpc(),
      registry: registry([entry({})]),
      expectCodes: ["exit_unknown_contract_version"],
    },
    {
      name: "a classic asset with no trustline on the account",
      position,
      rpc: rpc(),
      registry: KNOWN,
      ctx: { tokenBalances: { [XLM_SAC]: "50000000" } },
      expectCodes: ["soroswap_trustline_missing"],
    },
    {
      name: "shares worth less than one base unit of a reserve",
      position,
      rpc: rpc({ shares: 1n, reserve1: 5n }),
      registry: KNOWN,
      expectCodes: ["soroswap_position_too_small"],
    },
  ],
  ctx,
});

async function runHealthy(over: Partial<FakePairOptions> = {}) {
  return runExitAdapter(adapter, position, ctx, {
    rpc: rpc(over),
    resolveWasmHash: KNOWN.resolveWasmHash,
    isRegistryFresh: () => true,
  });
}

describe("soroswap exit adapter", () => {
  test("plans one router withdrawal for every share, with floors at the account's share of each reserve less slippage", async () => {
    const result = await runHealthy();
    expect(result.blockers).toEqual([]);
    expect(result.plan).toHaveLength(1);
    const step = result.plan[0]!;
    expect(step).toMatchObject({
      kind: "lp_withdraw",
      contract: ROUTER,
      function: "remove_liquidity",
      asset: PAIR,
      amount: SHARES.toString(),
      ceiling: SHARES.toString(),
    });
    // 10% of 100 XLM = 10 XLM, less 0.5% = 9.95 XLM; 10% of 200 USDC = 20, less 0.5% = 19.9.
    expect(step.minReceived).toEqual([
      { asset: XLM_SAC, amount: "99500000" },
      { asset: USDC_SAC, amount: "199000000" },
    ]);
  });

  test("the built call names the tokens, every share, both floors, the account, and a deadline five minutes out", async () => {
    const result = await runHealthy();
    const next = result.next!;
    expect(next.intent.args).toEqual([
      XLM_SAC,
      USDC_SAC,
      SHARES.toString(),
      "99500000",
      "199000000",
      ACCOUNT,
      String(Math.floor(ctx.now.getTime() / 1000) + 300),
    ]);
    const envelope = xdr.TransactionEnvelope.fromXDR(next.simulation.txXdr, "base64");
    const op = envelope.v1().tx().operations()[0]!.body().invokeHostFunctionOp();
    const call = op.hostFunction().invokeContract();
    expect(Address.fromScAddress(call.contractAddress()).toString()).toBe(ROUTER);
    expect(call.functionName().toString()).toBe("remove_liquidity");
    const args = call.args().map((a) => scValToNative(a) as unknown);
    expect(args[0]).toBe(XLM_SAC);
    expect(args[1]).toBe(USDC_SAC);
    expect(args[2]).toBe(SHARES);
    expect(args[3]).toBe(99_500_000n);
    expect(args[4]).toBe(199_000_000n);
    expect(args[5]).toBe(ACCOUNT);
  });

  test("a pair the account no longer holds shares of is reported as gone, not refused", async () => {
    const result = await runHealthy({ shares: 0n });
    expect(result.next).toBeNull();
    expect(result.blockers.map((b) => b.code)).toEqual([EXIT_POSITION_GONE]);
  });

  test("a Soroban-native token needs no trustline", async () => {
    const result = await runExitAdapter(
      adapter,
      position,
      { ...ctx, tokenBalances: { [XLM_SAC]: "1" } },
      {
        rpc: rpc({ token1: SOROBAN_TOKEN, stellarAssets: [XLM_SAC] }),
        resolveWasmHash: KNOWN.resolveWasmHash,
        isRegistryFresh: () => true,
      }
    );
    expect(result.blockers).toEqual([]);
    expect(result.plan[0]!.minReceived[1]!.asset).toBe(SOROBAN_TOKEN);
  });

  test("a pair with no instance on the ledger, or a network without a verified router, blocks by name", async () => {
    // The runner's registry gate reads the pair's code before the adapter ever runs.
    const missing = await runHealthy({ pairMissing: true });
    expect(missing.blockers.map((b) => b.code)).toEqual(["exit_contract_unresolvable"]);

    const noRouter = soroswapExitAdapter({ routerFor: () => null, factoryFor: () => FACTORY });
    const result = await runExitAdapter(noRouter, position, ctx, {
      rpc: rpc(),
      resolveWasmHash: KNOWN.resolveWasmHash,
      isRegistryFresh: () => true,
    });
    expect(result.blockers.map((b) => b.code)).toEqual(["soroswap_router_unknown"]);
  });

  test("a position the registry knows as something other than a pair is refused", async () => {
    const asPool = registry([
      entry({ kind: "pool" }),
      entry({ kind: "router", address: ROUTER, wasmHash: SOROSWAP_ROUTER_HASH }),
    ]);
    const result = await runExitAdapter(adapter, position, ctx, {
      rpc: rpc(),
      resolveWasmHash: asPool.resolveWasmHash,
      isRegistryFresh: () => true,
    });
    expect(result.blockers.map((b) => b.code)).toEqual(["soroswap_contract_not_pair"]);
  });

  test("the shipped registry knows the testnet router and factory, and nothing on mainnet", () => {
    expect(defaultSoroswapDeps.routerFor("testnet")).toBe(ROUTER);
    expect(defaultSoroswapDeps.factoryFor("testnet")).toBe(FACTORY);
    expect(defaultSoroswapDeps.routerFor("mainnet")).toBeNull();
    expect(defaultSoroswapDeps.factoryFor("mainnet")).toBeNull();
  });

  test("a share entry that is absent from the ledger blocks - it is not a zero", async () => {
    // The pair writes 0 on a full withdrawal and never deletes the entry, so absence means the
    // ledger is not telling us the balance (archived, most likely). Treating it as gone would let
    // the close merge the account with its shares still in the pair.
    const result = await runHealthy({ balanceMissing: true });
    expect(result.next).toBeNull();
    expect(result.blockers.map((b) => b.code)).toEqual(["soroswap_shares_unreadable"]);
  });

  test("a pair deployed by another factory blocks by name - the router would not find it", async () => {
    const result = await runHealthy({ pairFactory: SOROBAN_TOKEN });
    expect(result.blockers.map((b) => b.code)).toEqual(["soroswap_pair_foreign_factory"]);
  });

  test("with protocol fees on, the floors expect the fee shares the pair mints before paying out", async () => {
    // k grew from kLast: sqrt(k) = 1_414_213_562 (r0*r1 = 2e18), sqrt(kLast) = 1_000_000_000. The
    // pair mints TS*(sqrtK - sqrtKLast)/(5*sqrtK + sqrtKLast) shares to the protocol first.
    const kLast = 1_000_000_000_000_000_000n;
    const state = { reserve0: RESERVE_0, reserve1: RESERVE_1, totalSupply: TOTAL_SUPPLY };
    const minted = protocolFeeShares({ ...state, kLast, feesEnabled: true });
    expect(minted).toBeGreaterThan(0n);
    const result = await runHealthy({ kLast, feesEnabled: true });
    expect(result.blockers).toEqual([]);
    const [floor0, floor1] = result.plan[0]!.minReceived;
    const floorOf = (reserve: bigint): string =>
      ((((SHARES * reserve) / (TOTAL_SUPPLY + minted)) * 9_950n) / 10_000n).toString();
    expect(floor0!.amount).toBe(floorOf(RESERVE_0));
    expect(floor1!.amount).toBe(floorOf(RESERVE_1));
    expect(BigInt(floor0!.amount)).toBeLessThan(99_500_000n);
    // Fees off, or k unchanged since the last liquidity event: nothing is minted.
    expect(protocolFeeShares({ ...state, kLast, feesEnabled: false })).toBe(0n);
    expect(protocolFeeShares({ ...state, kLast: RESERVE_0 * RESERVE_1, feesEnabled: true })).toBe(
      0n
    );
  });

  test("isqrt is the exact floor square root", () => {
    expect(isqrt(0n)).toBe(0n);
    expect(isqrt(1n)).toBe(1n);
    expect(isqrt(2_000_000_000_000_000_000n)).toBe(1_414_213_562n);
    expect(isqrt(10n ** 40n)).toBe(10n ** 20n);
    expect(isqrt(10n ** 40n - 1n)).toBe(10n ** 20n - 1n);
  });
});
