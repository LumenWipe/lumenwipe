/**
 * The Phoenix exit adapter under the shared invariant harness, plus what is specific to it: an
 * LP-only withdrawal, unbonding every stake before any withdrawal (oldest timestamp first, one
 * step per round), the persistent-storage absent-entry handling, and the `i128`/`u64`/void
 * argument encoding `withdraw_liquidity` and `unbond` actually need.
 */
import { describe, expect, test } from "bun:test";
import { StrKey, scValToNative, xdr } from "@stellar/stellar-sdk";
import type { PhoenixLpPosition, PhoenixStakePosition } from "@lumenwipe/types";
import { EXIT_POSITION_GONE, phoenixExitAdapter, runExitAdapter } from "@/lib/defi-exits";
import {
  phoenixNewLpKey,
  phoenixStakeConfigKey,
  phoenixUnbondToken,
} from "@/lib/defi-exits/phoenix";
import {
  createContractRegistryLookup,
  validateContractRegistry,
  type ContractRegistryEntry,
  type ContractRegistryLookup,
} from "@/lib/contract-registry";
import { describeExitAdapterInvariants, harnessContext } from "./fixtures/exit-adapter-harness";
import {
  PHX_POOL_HASH,
  PHX_STAKE_HASH,
  POOL,
  SHARE_TOKEN,
  STAKE_CONTRACT,
  SOROBAN_TOKEN,
  USDC_SAC,
  XLM_SAC,
  fakePhoenixRpc,
  randomAccount,
  type FakePhoenixOptions,
} from "./fixtures/fake-phoenix-pool";
import { invokeContractArgs, v1TransactionFromXdr } from "../support/v1-transaction";
import { ARCHIVED } from "./fixtures/entry-archival";

const ACCOUNT = randomAccount();
/** A pool's former share token, still named by a v2 stake contract's stale `CONFIG.lp_token`. */
const OLD_LP_TOKEN = StrKey.encodeContract(Buffer.alloc(32, 7));
const SHARES = 100_000_000n; // 10% of the 1_000_000_000 total: 10% of each reserve
const RESERVES = [1_000_000_000n, 2_000_000_000n] as const; // 100 XLM, 200 USDC

function entry(over: Partial<ContractRegistryEntry>): ContractRegistryEntry {
  return {
    network: "testnet",
    protocol: "phoenix",
    kind: "pool",
    address: POOL,
    wasmHash: PHX_POOL_HASH,
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
      source: "phoenix adapter test",
      entries,
    })
  );
}

const KNOWN = registry([
  entry({}),
  entry({ address: STAKE_CONTRACT, wasmHash: PHX_STAKE_HASH, kind: "stake" }),
]);

/** Detection overstates on purpose: the harness checks that amounts come from the live read. */
const lpPosition: PhoenixLpPosition = {
  protocol: "phoenix",
  positionType: "lp",
  contractAddress: POOL,
  shareAmount: (SHARES * 3n).toString(),
  usdValue: null,
};

const stakePosition: PhoenixStakePosition = {
  protocol: "phoenix",
  positionType: "stake",
  contractAddress: POOL,
  stakedAmount: (SHARES * 3n).toString(),
  stakedAtEpoch: "1700000000",
  usdValue: null,
};

const adapter = phoenixExitAdapter();

function rpc(over: Partial<FakePhoenixOptions> = {}) {
  return fakePhoenixRpc({ account: ACCOUNT, reserves: [...RESERVES], shares: SHARES, ...over });
}

// The account holds a USDC trustline (its SAC appears in tokenBalances); XLM needs none in real
// life, but this fixture's "XLM_SAC" is a stand-in classic asset, not the network's real native
// contract, so it needs one too for the happy path.
const ctx = harnessContext({
  account: ACCOUNT,
  tokenBalances: { [XLM_SAC]: "50000000", [USDC_SAC]: "0" },
});

describeExitAdapterInvariants("phoenix pool", {
  adapter,
  healthy: {
    position: lpPosition,
    rpc: rpc(),
    registry: KNOWN,
    detectedAmount: lpPosition.shareAmount,
    liveCeiling: { [POOL]: SHARES.toString() },
  },
  simulationFails: { position: lpPosition, rpc: rpc({ simulation: "error" }), registry: KNOWN },
  archived: (archival) => ({ position: lpPosition, rpc: rpc({ archival }), registry: KNOWN }),
  simulationNeedsRestore: {
    position: lpPosition,
    rpc: rpc({ simulation: "restore" }),
    registry: KNOWN,
  },
  blocked: [
    {
      name: "the pool's contract is registered as a different kind",
      position: lpPosition,
      rpc: rpc(),
      registry: registry([entry({ kind: "pair" })]),
      expectCodes: ["phoenix_contract_not_pool"],
    },
    {
      name: "the pool cannot be read at all",
      position: lpPosition,
      rpc: rpc({ poolMissing: true }),
      registry: KNOWN,
      expectCodes: ["phoenix_pool_unreadable"],
    },
    {
      name: "an LP position whose share balance is absent from the ledger",
      position: lpPosition,
      rpc: rpc({ shareBalanceMissing: true }),
      registry: KNOWN,
      expectCodes: ["phoenix_shares_unreadable"],
    },
    {
      name: "a stake position whose bonding entry is absent from the ledger",
      position: stakePosition,
      rpc: rpc({ shares: 0n, bondingInfoMissing: true }),
      registry: KNOWN,
      expectCodes: ["phoenix_stakes_unreadable"],
    },
    {
      name: "a classic asset with no trustline on the account",
      position: lpPosition,
      rpc: rpc(),
      registry: KNOWN,
      ctx: { tokenBalances: { [XLM_SAC]: "50000000" } },
      expectCodes: ["phoenix_trustline_missing"],
    },
    {
      name: "shares worth less than one base unit of a reserve",
      position: lpPosition,
      rpc: rpc({ shares: 1n, reserves: [1_000_000_000n, 5n] }),
      registry: KNOWN,
      expectCodes: ["phoenix_position_too_small"],
    },
    {
      name: "a pool with no reserves left",
      position: lpPosition,
      rpc: rpc({ reserves: [0n, 0n] }),
      registry: KNOWN,
      expectCodes: ["phoenix_pool_empty"],
    },
    {
      name: "a stake contract that pays another token than the pool's share token on unbond",
      position: stakePosition,
      rpc: rpc({ shares: 0n, stakes: [{ amount: 1n, timestamp: 1n }], stakeLpToken: OLD_LP_TOKEN }),
      registry: KNOWN,
      expectCodes: ["phoenix_stake_token_mismatch"],
    },
  ],
  ctx,
});

async function run(over: Partial<FakePhoenixOptions> = {}, ctxOver: Partial<typeof ctx> = {}) {
  return runExitAdapter(
    adapter,
    over.stakes ? stakePosition : lpPosition,
    { ...ctx, ...ctxOver },
    { rpc: rpc(over), resolveCode: KNOWN.resolveCode, isRegistryFresh: () => true }
  );
}

function invocationArgs(txXdr: string): xdr.ScVal[] {
  return invokeContractArgs(v1TransactionFromXdr(txXdr).operations[0]!).args;
}

describe("phoenix exit adapter", () => {
  test("plans one withdrawal of the full share balance with a floor per token", async () => {
    const result = await run();
    expect(result.blockers).toEqual([]);
    expect(result.plan.map((s) => s.kind)).toEqual(["lp_withdraw"]);
    const step = result.plan[0]!;
    expect(step).toMatchObject({
      contract: POOL,
      function: "withdraw_liquidity",
      asset: POOL,
      amount: SHARES.toString(),
      ceiling: SHARES.toString(),
    });
    // 10% of 100 XLM less 0.5% = 9.95 XLM; 10% of 200 USDC less 0.5% = 19.9 USDC.
    expect(step.minReceived).toEqual([
      { asset: XLM_SAC, amount: "99500000" },
      { asset: USDC_SAC, amount: "199000000" },
    ]);
  });

  // Regression guard: the real pool's withdraw_liquidity takes exactly five arguments (sender,
  // share_amount, min_a, min_b, deadline) - confirmed against a live pool's own
  // `stellar contract info interface`. A sixth trailing argument (a stale assumption that
  // `auto_unstake` was its own parameter) always failed the real call; nothing in this file's
  // fake harness could ever have caught that, since it reimplements whatever this adapter itself
  // emits rather than the real contract's own argument count.
  test("withdraw_liquidity is called with exactly five args: i128 amounts and a void deadline", async () => {
    const result = await run();
    if (!result.next) throw new Error("expected a built step");
    const args = invocationArgs(result.next.simulation.txXdr);
    expect(args).toHaveLength(5);
    expect(args[1]!.type).toBe("scvI128");
    expect(args[2]!.type).toBe("scvI128");
    expect(args[3]!.type).toBe("scvI128");
    expect(args[4]!.type).toBe("scvVoid");
  });

  test("unbonds every stake before any withdrawal, oldest timestamp first, one step per round", async () => {
    const stakes = [
      { amount: 5_000_000n, timestamp: 200n },
      { amount: 3_000_000n, timestamp: 100n },
    ];
    const result = await run({ shares: 0n, stakes });
    expect(result.blockers).toEqual([]);
    expect(result.plan.map((s) => s.kind)).toEqual(["unstake", "unstake"]);
    expect(result.plan[0]).toMatchObject({
      contract: STAKE_CONTRACT,
      function: "unbond",
      asset: SHARE_TOKEN,
      amount: "3000000",
      ceiling: "3000000",
      minReceived: [],
    });
    expect(result.plan[1]).toMatchObject({ amount: "5000000", ceiling: "5000000" });
    // Only the oldest stake's unbond is built this round.
    expect(result.next?.step.kind).toBe("unstake");
    expect(result.next?.step.amount).toBe("3000000");
    const args = invocationArgs(result.next!.simulation.txXdr);
    expect(args).toHaveLength(3);
    expect(args[1]!.type).toBe("scvI128");
    expect(args[2]!.type).toBe("scvU64");
    expect(scValToNative(args[2]!)).toBe(100n);
  });

  test("an archived bonding entry is read as the stakes it holds: the same unbond plan as live", async () => {
    const stakes = [{ amount: 3_000_000n, timestamp: 100n }];
    const live = await run({ shares: 0n, stakes });
    for (const archival of ARCHIVED) {
      const result = await run({ shares: 0n, stakes, archival });
      expect(result.blockers).toEqual([]);
      expect(result.plan).toEqual(live.plan);
      expect(result.next?.step).toEqual(live.next!.step);
    }
  });

  test("a fully unstaked position with no shares left is reported as already gone", async () => {
    const result = await run({ shares: 0n, stakes: [] });
    expect(result.next).toBeNull();
    expect(result.blockers.map((b) => b.code)).toEqual([EXIT_POSITION_GONE]);
  });

  test("a stake position with no bonding entry, and no LP position at all, has nothing to unbond", async () => {
    // No stake position claims a bonding entry exists here, so its absence is the normal "never
    // staked" case, not `phoenix_stakes_unreadable` - but with shares also at 0, the position is
    // simply gone.
    const result = await runExitAdapter(adapter, lpPosition, ctx, {
      rpc: rpc({ shares: 0n, bondingInfoMissing: true }),
      resolveCode: KNOWN.resolveCode,
      isRegistryFresh: () => true,
    });
    expect(result.next).toBeNull();
    expect(result.blockers.map((b) => b.code)).toEqual([EXIT_POSITION_GONE]);
  });

  test("a Soroban-native reserve token needs no trustline", async () => {
    const result = await run({
      tokens: [SOROBAN_TOKEN, USDC_SAC],
      stellarAssets: [USDC_SAC],
    });
    expect(result.blockers).toEqual([]);
    expect(result.plan[0]!.minReceived[0]!.asset).toBe(SOROBAN_TOKEN);
  });

  // Mainnet pool CD5XNKK3… and its stake CDOXQONP…: the stake's CONFIG.lp_token still names the
  // old share token while its v2 code pays NEWLP, the pool's share token, and the pool is empty.
  test("a v2 stake paying its NEWLP token, the pool's share token, unbonds despite a stale lp_token", async () => {
    const stakes = [{ amount: 3_000_000n, timestamp: 100n }];
    const result = await run({
      shares: 0n,
      stakes,
      stakeLpToken: OLD_LP_TOKEN,
      stakeNewLp: SHARE_TOKEN,
    });
    expect(result.blockers).toEqual([]);
    expect(result.plan).toHaveLength(1);
    expect(result.plan[0]).toMatchObject({ kind: "unstake", contract: STAKE_CONTRACT });
    expect(result.plan[0]!.asset).toBe(SHARE_TOKEN);
  });

  test("a stake in an empty pool is never unbonded nor withdrawn: phoenix_pool_empty, leavable", async () => {
    const result = await run({
      reserves: [0n, 0n],
      shares: 0n,
      stakes: [{ amount: 3_000_000n, timestamp: 100n }],
      stakeLpToken: OLD_LP_TOKEN,
      stakeNewLp: SHARE_TOKEN,
    });
    expect(result.plan).toEqual([]);
    expect(result.next).toBeNull();
    expect(result.blockers.map((b) => b.code)).toEqual(["phoenix_pool_empty"]);
    expect(result.leaveEligible).toBe(true);
  });

  test("plain shares of an empty pool are not withdrawn either", async () => {
    const result = await run({ reserves: [0n, 0n] });
    expect(result.plan).toEqual([]);
    expect(result.blockers.map((b) => b.code)).toEqual(["phoenix_pool_empty"]);
    expect(result.leaveEligible).toBe(true);
  });

  test("one empty reserve is enough to build nothing", async () => {
    const result = await run({ reserves: [1_000_000_000n, 0n] });
    expect(result.plan).toEqual([]);
    expect(result.blockers.map((b) => b.code)).toEqual(["phoenix_pool_empty"]);
  });

  test("a stake paying another token than the share token is never unbonded: leavable blocker", async () => {
    for (const over of [
      { stakeLpToken: OLD_LP_TOKEN },
      { stakeNewLp: OLD_LP_TOKEN },
      { stakeConfigMissing: true },
    ]) {
      const result = await run({ shares: 0n, stakes: [{ amount: 1n, timestamp: 1n }], ...over });
      expect(result.plan).toEqual([]);
      expect(result.next).toBeNull();
      expect(result.blockers.map((b) => b.code)).toEqual(["phoenix_stake_token_mismatch"]);
      expect(result.leaveEligible).toBe(true);
    }
  });

  test("plain shares are withdrawn as usual when only the stake contract pays another token", async () => {
    const result = await run({ stakeLpToken: OLD_LP_TOKEN });
    expect(result.blockers).toEqual([]);
    expect(result.plan.map((s) => s.kind)).toEqual(["lp_withdraw"]);
  });
});

describe("phoenixUnbondToken", () => {
  async function stakeEntries(over: Partial<FakePhoenixOptions>) {
    const configKey = phoenixStakeConfigKey(STAKE_CONTRACT);
    const newLpKey = phoenixNewLpKey(STAKE_CONTRACT);
    const res = await rpc(over).getLedgerEntries(configKey, newLpKey);
    const byKey = new Map(res.entries.map((e) => [e.key.toXdr("base64"), e.val]));
    return [byKey.get(configKey.toXdr("base64")), byKey.get(newLpKey.toXdr("base64"))] as const;
  }

  test("pays NEWLP when the stake has one, whatever CONFIG.lp_token says", async () => {
    const [config, newLp] = await stakeEntries({
      stakeLpToken: OLD_LP_TOKEN,
      stakeNewLp: SHARE_TOKEN,
    });
    expect(phoenixUnbondToken(config, newLp)).toBe(SHARE_TOKEN);
  });

  test("pays CONFIG.lp_token when there is no NEWLP", async () => {
    const [config, newLp] = await stakeEntries({ stakeLpToken: OLD_LP_TOKEN });
    expect(newLp).toBeUndefined();
    expect(phoenixUnbondToken(config, newLp)).toBe(OLD_LP_TOKEN);
  });

  test("is null when the stake's CONFIG is absent or names no contract", async () => {
    const [config] = await stakeEntries({ stakeConfigMissing: true });
    expect(phoenixUnbondToken(config, undefined)).toBeNull();
    const [accountLp] = await stakeEntries({ stakeLpToken: ACCOUNT });
    expect(phoenixUnbondToken(accountLp, undefined)).toBeNull();
  });
});
