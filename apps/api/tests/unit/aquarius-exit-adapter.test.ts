/**
 * The Aquarius exit adapter under the shared invariant harness, plus what is specific to a pool:
 * rewards claimed before the withdrawal (and what stops them), floors per token in the pool's own
 * order, the trustline prerequisite for classic assets, and the two calls the steps become.
 */
import { describe, expect, test } from "bun:test";
import {
  Address,
  TransactionBuilder,
  scValToNative,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import type { AquariusLpPosition } from "@lumenwipe/types";
import { EXIT_POSITION_GONE, aquariusExitAdapter, runExitAdapter } from "@/lib/defi-exits";
import { promoteRewardKeys } from "@/lib/defi-exits/aquarius";
import {
  createContractRegistryLookup,
  validateContractRegistry,
  type ContractRegistryEntry,
  type ContractRegistryLookup,
} from "@/lib/contract-registry";
import { describeExitAdapterInvariants, harnessContext } from "./fixtures/exit-adapter-harness";
import {
  AQUA_SAC,
  AQ_CONCENTRATED_HASH,
  AQ_CONSTANT_HASH,
  AQ_STABLE_HASH,
  POOL,
  SHARE_TOKEN,
  SOROBAN_TOKEN,
  USDC_SAC,
  XLM_SAC,
  dataKey,
  fakeAquariusRpc,
  randomAccount,
  sameperiodFootprint,
  type FakeAquariusOptions,
} from "./fixtures/fake-aquarius-pool";

const ACCOUNT = randomAccount();
const SHARES = 100_000_000n; // 10% of the 1_000_000_000 total: 10% of each reserve
const RESERVES = [1_000_000_000n, 2_000_000_000n]; // 100 XLM, 200 USDC

function entry(over: Partial<ContractRegistryEntry>): ContractRegistryEntry {
  return {
    network: "testnet",
    protocol: "aquarius",
    kind: "pool",
    address: POOL,
    wasmHash: AQ_CONSTANT_HASH,
    version: "constant_product",
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
      source: "aquarius adapter test",
      entries,
    })
  );
}

const KNOWN = registry([
  entry({}),
  entry({
    address: "CDDLEQE6CPQGIK3RU4MK5CX2IAWN6CXWNJ2C3VOXV4FOVF3BBQFVZDIC",
    wasmHash: AQ_STABLE_HASH,
    version: "stable",
  }),
  entry({
    address: "CCS6EFFKPQWG5SKMMYL4UQIXVYVDNIXAPHKHUM7IGJVN7QIAWXD2L7TO",
    wasmHash: AQ_CONCENTRATED_HASH,
    version: "concentrated",
  }),
]);

/** Detection overstates on purpose: the harness checks that amounts come from the live read. */
const position: AquariusLpPosition = {
  protocol: "aquarius",
  positionType: "lp",
  contractAddress: POOL,
  shareAmount: (SHARES * 3n).toString(),
  usdValue: null,
  tokens: [XLM_SAC, USDC_SAC],
  shareToken: SHARE_TOKEN,
  poolType: "constant_product",
};

const adapter = aquariusExitAdapter();

function rpc(over: Partial<FakeAquariusOptions> = {}) {
  return fakeAquariusRpc({ account: ACCOUNT, reserves: RESERVES, shares: SHARES, ...over });
}

// The account holds USDC and AQUA trustlines (their SACs appear in tokenBalances); XLM needs none.
const ctx = harnessContext({
  account: ACCOUNT,
  tokenBalances: { [XLM_SAC]: "50000000", [USDC_SAC]: "0", [AQUA_SAC]: "0" },
});

describeExitAdapterInvariants("aquarius constant-product pool", {
  adapter,
  healthy: {
    position,
    rpc: rpc(),
    registry: KNOWN,
    detectedAmount: position.shareAmount,
    liveCeiling: { [POOL]: SHARES.toString() },
  },
  simulationFails: { position, rpc: rpc({ simulation: "error" }), registry: KNOWN },
  simulationNeedsRestore: { position, rpc: rpc({ simulation: "restore" }), registry: KNOWN },
  blocked: [
    {
      name: "the pool's code is not one the registry verified",
      position,
      rpc: rpc({ poolHash: "1".repeat(64) }),
      registry: KNOWN,
      expectCodes: ["exit_unknown_contract_version"],
    },
    {
      name: "a classic asset with no trustline on the account",
      position,
      rpc: rpc(),
      registry: KNOWN,
      ctx: { tokenBalances: { [XLM_SAC]: "50000000", [AQUA_SAC]: "0" } },
      expectCodes: ["aquarius_trustline_missing"],
    },
    {
      name: "shares worth less than one base unit of a reserve",
      position,
      rpc: rpc({ shares: 1n, reserves: [1_000_000_000n, 5n] }),
      registry: KNOWN,
      expectCodes: ["aquarius_position_too_small"],
    },
    {
      name: "accrued rewards while the pool's claiming is paused",
      position,
      rpc: rpc({ reward: 42n, claimKilled: true }),
      registry: KNOWN,
      expectCodes: ["aquarius_rewards_claim_paused"],
    },
    {
      name: "accrued rewards with no AQUA trustline to receive them",
      position,
      rpc: rpc({ reward: 42n }),
      registry: KNOWN,
      ctx: { tokenBalances: { [XLM_SAC]: "50000000", [USDC_SAC]: "0" } },
      expectCodes: ["aquarius_reward_trustline_missing"],
    },
  ],
  ctx,
});

async function run(over: Partial<FakeAquariusOptions> = {}, ctxOver: Partial<typeof ctx> = {}) {
  return runExitAdapter(
    adapter,
    position,
    { ...ctx, ...ctxOver },
    {
      rpc: rpc(over),
      resolveWasmHash: KNOWN.resolveWasmHash,
      isRegistryFresh: () => true,
    }
  );
}

describe("aquarius exit adapter", () => {
  test("plans one withdrawal of every share with a floor per token, in the pool's own order", async () => {
    const result = await run();
    expect(result.blockers).toEqual([]);
    expect(result.plan.map((s) => s.kind)).toEqual(["lp_withdraw"]);
    const step = result.plan[0]!;
    expect(step).toMatchObject({
      contract: POOL,
      function: "withdraw",
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

  test("accrued rewards are claimed first, as their own step, and the withdrawal follows", async () => {
    const result = await run({ reward: 4_200n });
    expect(result.blockers).toEqual([]);
    expect(result.plan.map((s) => s.kind)).toEqual(["claim", "lp_withdraw"]);
    expect(result.plan[0]).toMatchObject({
      contract: POOL,
      function: "claim",
      asset: AQUA_SAC,
      amount: "4200",
      ceiling: "4200",
      minReceived: [],
    });
    // Only the first step is built this round; the claim call names just the account.
    expect(result.next?.step.kind).toBe("claim");
    expect(result.next?.intent.args).toEqual([ACCOUNT]);
  });

  test("the built withdrawal names the account, every share, and one floor per token as u128", async () => {
    const result = await run();
    const envelope = xdr.TransactionEnvelope.fromXDR(result.next!.simulation.txXdr, "base64");
    const call = envelope
      .v1()
      .tx()
      .operations()[0]!
      .body()
      .invokeHostFunctionOp()
      .hostFunction()
      .invokeContract();
    expect(Address.fromScAddress(call.contractAddress()).toString()).toBe(POOL);
    expect(call.functionName().toString()).toBe("withdraw");
    const args = call.args().map((a) => scValToNative(a) as unknown);
    expect(args).toEqual([ACCOUNT, SHARES, [99_500_000n, 199_000_000n]]);
    expect(result.next!.intent.args).toEqual([ACCOUNT, SHARES.toString(), "99500000", "199000000"]);
  });

  test("a stableswap pool is read from its Tokens and Reserves vectors", async () => {
    const stable = registry([entry({ wasmHash: AQ_STABLE_HASH, version: "stable" })]);
    const result = await runExitAdapter(adapter, position, ctx, {
      rpc: rpc({ layout: "stable", poolHash: AQ_STABLE_HASH }),
      resolveWasmHash: stable.resolveWasmHash,
      isRegistryFresh: () => true,
    });
    expect(result.blockers).toEqual([]);
    expect(result.plan[0]!.minReceived.map((m) => m.amount)).toEqual(["99500000", "199000000"]);
  });

  test("shares already withdrawn and nothing to claim is 'gone'; shares gone but rewards left claims only", async () => {
    const gone = await run({ shares: 0n });
    expect(gone.next).toBeNull();
    expect(gone.blockers.map((b) => b.code)).toEqual([EXIT_POSITION_GONE]);
    const rewardsOnly = await run({ shares: 0n, reward: 7n });
    expect(rewardsOnly.blockers).toEqual([]);
    expect(rewardsOnly.plan.map((s) => s.kind)).toEqual(["claim"]);
  });

  test("a share entry absent from the ledger blocks - it is not a zero", async () => {
    const result = await run({ balanceMissing: true });
    expect(result.next).toBeNull();
    expect(result.blockers.map((b) => b.code)).toEqual(["aquarius_shares_unreadable"]);
  });

  test("rewards that cannot be read block rather than risk losing them in the merge", async () => {
    const result = await run({ rewardReadFails: true });
    expect(result.blockers.map((b) => b.code)).toEqual(["aquarius_rewards_unreadable"]);
  });

  test("a pool whose token is also the reward token (XLM/AQUA) reads and plans normally", async () => {
    const result = await runExitAdapter(
      adapter,
      position,
      { ...ctx, tokenBalances: { [XLM_SAC]: "1", [AQUA_SAC]: "0" } },
      {
        rpc: rpc({ tokens: [XLM_SAC, AQUA_SAC], reward: 5n }),
        resolveWasmHash: KNOWN.resolveWasmHash,
        isRegistryFresh: () => true,
      }
    );
    expect(result.blockers).toEqual([]);
    expect(result.plan.map((s) => s.kind)).toEqual(["claim", "lp_withdraw"]);
  });

  test("a Soroban-native pool token needs no trustline", async () => {
    const result = await runExitAdapter(
      adapter,
      position,
      { ...ctx, tokenBalances: { [XLM_SAC]: "1", [AQUA_SAC]: "0" } },
      {
        rpc: rpc({ tokens: [XLM_SAC, SOROBAN_TOKEN], stellarAssets: [XLM_SAC, AQUA_SAC] }),
        resolveWasmHash: KNOWN.resolveWasmHash,
        isRegistryFresh: () => true,
      }
    );
    expect(result.blockers).toEqual([]);
    expect(result.plan[0]!.minReceived[1]!.asset).toBe(SOROBAN_TOKEN);
  });

  test("a concentrated pool, and a contract registered as something other than a pool, are refused by name", async () => {
    const concentrated = await runExitAdapter(adapter, position, ctx, {
      rpc: rpc({ poolHash: AQ_CONCENTRATED_HASH }),
      resolveWasmHash: KNOWN.resolveWasmHash,
      isRegistryFresh: () => true,
    });
    expect(concentrated.blockers.map((b) => b.code)).toEqual(["aquarius_pool_type_unsupported"]);

    const asRouter = registry([entry({ kind: "router" })]);
    const notPool = await runExitAdapter(adapter, position, ctx, {
      rpc: rpc(),
      resolveWasmHash: asRouter.resolveWasmHash,
      isRegistryFresh: () => true,
    });
    expect(notPool.blockers.map((b) => b.code)).toEqual(["aquarius_contract_not_pool"]);
  });

  test("a pool with no instance on the ledger is stopped by the registry gate", async () => {
    const result = await run({ poolMissing: true });
    expect(result.blockers.map((b) => b.code)).toEqual(["exit_contract_unresolvable"]);
  });

  describe("footprint hardening: the account's reward keys are offered read-write", () => {
    // Two reward gauges (any contract ids will do; the real ones are one per pool and period).
    const GAUGES = [
      Address.contract(Buffer.alloc(32, 0x11)).toString(),
      Address.contract(Buffer.alloc(32, 0x22)).toString(),
    ];
    const rewardKey = (gauge: string, who: string) =>
      dataKey(gauge, xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("UserRewardData"), addr(who)]));
    const addr = (a: string) => new Address(a).toScVal();
    const footprintOf = (txXdr: string) => {
      const tx = xdr.TransactionEnvelope.fromXDR(txXdr, "base64").v1().tx();
      const data = tx.ext().sorobanData();
      const b64 = (k: xdr.LedgerKey) => k.toXDR("base64");
      return {
        readOnly: data.resources().footprint().readOnly().map(b64),
        readWrite: data.resources().footprint().readWrite().map(b64),
        writeBytes: data.resources().writeBytes(),
        resourceFee: data.resourceFee().toBigInt(),
        fee: tx.fee(),
      };
    };

    test("the offered withdrawal moves every gauge's per-account reward key from read-only to read-write, and nothing else", async () => {
      const result = await run({ rewardGauges: GAUGES });
      expect(result.blockers).toEqual([]);
      const offered = footprintOf(result.next!.simulation.txXdr);
      const before = sameperiodFootprint(ACCOUNT, GAUGES);
      for (const gauge of GAUGES) {
        const key = rewardKey(gauge, ACCOUNT).toXDR("base64");
        expect(offered.readOnly).not.toContain(key);
        expect(offered.readWrite).toContain(key);
      }
      // The pool instance, a stranger's reward data, and the account's XLM balance stay read-only;
      // the share balance was already writable.
      const promoted = new Set(GAUGES.map((g) => rewardKey(g, ACCOUNT).toXDR("base64")));
      expect(offered.readOnly).toEqual(
        before.readOnly.map((k) => k.toXDR("base64")).filter((k) => !promoted.has(k))
      );
      expect(offered.readWrite.slice(0, 1)).toEqual(before.readWrite.map((k) => k.toXDR("base64")));
      expect(offered.readWrite).toHaveLength(3);
    });

    test("the declared write capacity and the resource fee grow per promoted key, and the total fee follows", async () => {
      const result = await run({ rewardGauges: GAUGES });
      const offered = footprintOf(result.next!.simulation.txXdr);
      expect(offered.writeBytes).toBe(300 + 2 * 512);
      expect(offered.resourceFee).toBe(12_345n + 2n * 50_000n);
      // The inclusion fee is untouched: total = inclusion + resource fee, before and after.
      const untouched = footprintOf((await run()).next!.simulation.txXdr);
      expect(BigInt(offered.fee) - offered.resourceFee).toBe(
        BigInt(untouched.fee) - untouched.resourceFee
      );
      expect(untouched.writeBytes).toBe(300);
    });

    test("with no reward key of the account's in the read-only set, the transaction is returned as is", async () => {
      const result = await run();
      const tx = TransactionBuilder.fromXDR(
        result.next!.simulation.txXdr,
        "Test SDF Network ; September 2015"
      ) as Transaction;
      expect(promoteRewardKeys(tx, ACCOUNT)).toBe(tx);
      const claimed = footprintOf(result.next!.simulation.txXdr);
      expect(claimed.readOnly).toEqual([]);
    });

    test("the hardened transaction still passes the runner's intent, auth, and fee checks - the call itself is unchanged", async () => {
      const result = await run({ rewardGauges: GAUGES, reward: 9n });
      expect(result.blockers).toEqual([]);
      expect(result.next?.step.kind).toBe("claim");
      expect(result.next?.intent.args).toEqual([ACCOUNT]);
    });
  });
});
