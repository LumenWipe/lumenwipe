import { describe, expect, test } from "bun:test";
import { RequestType, Version } from "@blend-capital/blend-sdk";
import { Address, scValToNative, xdr } from "@stellar/stellar-sdk";
import type { BlendBorrowPosition, BlendSupplyPosition } from "@lumenwipe/types";
import { assessRepayPlanned, runExitAdapter } from "@/lib/defi-exits";
import { blendExitAdapter, type BlendPosition } from "@/lib/defi-exits/blend";
import {
  describeExitAdapterInvariants,
  harnessContext,
  registryKnowing,
} from "./fixtures/exit-adapter-harness";
import { fakeExitRpc } from "./fixtures/fake-exit-adapter";
import { USDC, XLM, fakeBlendDeps } from "./fixtures/fake-blend-pool";

// Sebas's registry entry for the official Blend V2 testnet pool, reused as the fixture address.
const POOL = "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF";
const WASM_HASH = "a41fc53d6753b6c04eb15b021c55052366a4c8e0e21bc72700f461264ec1350e";
const CODE = { version: "v2", kind: "pool" as const };

const registry = registryKnowing(POOL, WASM_HASH, "blend", "pool", "testnet", "v2");
const ctx = harnessContext({ tokenBalances: { [USDC]: "500000000" } }); // holds 50 USDC
const rpc = (simulation: "ok" | "error" = "ok") =>
  fakeExitRpc({ liveWasmHash: WASM_HASH, liveBalance: "0", simulation });

function supplyPosition(overrides: Partial<BlendSupplyPosition> = {}): BlendSupplyPosition {
  return {
    protocol: "blend",
    positionType: "supply",
    contractAddress: POOL,
    assetAddress: USDC,
    // Detection overstates: 2e9 bTokens is 2.1e9 underlying, against 1.05e9 read live.
    bTokenAmount: "2000000000",
    usdValue: null,
    ...overrides,
  };
}

function borrowPosition(): BlendBorrowPosition {
  return {
    protocol: "blend",
    positionType: "borrow",
    contractAddress: POOL,
    assetAddress: USDC,
    dTokenAmount: "100000000",
    usdValue: null,
  };
}

// 100 USDC of bTokens -> 105 USDC underlying (the live ceiling) -> asked as 105.105.
const SUPPLY_ONLY = { supply: { [USDC]: 1_000_000_000n } };
const SUPPLY_UNDERLYING = "1050000000";
const SUPPLY_ASK = "1051050000";

// 500 XLM collateral (525 underlying, $47.25 effective) against 10 USDC of dTokens
// (10.2 underlying, $11.22 effective), plus the USDC supply above.
const INDEBTED = {
  collateral: { [XLM]: 5_000_000_000n },
  liabilities: { [USDC]: 100_000_000n },
  supply: { [USDC]: 1_000_000_000n },
};
const COLLATERAL_UNDERLYING = "5250000000";
const COLLATERAL_ASK = "5255250000";
const DEBT_ASK = "102102000"; // 10.2 USDC + 10 bps, rounded up

describeExitAdapterInvariants("blend", {
  adapter: blendExitAdapter(fakeBlendDeps(SUPPLY_ONLY)),
  healthy: {
    position: supplyPosition(),
    rpc: rpc(),
    registry,
    detectedAmount: "2100000000",
    liveCeiling: SUPPLY_UNDERLYING,
  },
  simulationFails: { position: supplyPosition(), rpc: rpc("error"), registry },
  ctx,
});

describeExitAdapterInvariants("blend, with debt", {
  adapter: blendExitAdapter(fakeBlendDeps(INDEBTED)),
  healthy: {
    position: borrowPosition(),
    rpc: rpc(),
    registry,
    detectedAmount: "2100000000",
    liveCeiling: { [USDC]: SUPPLY_UNDERLYING, [XLM]: COLLATERAL_UNDERLYING },
  },
  simulationFails: { position: borrowPosition(), rpc: rpc("error"), registry },
  indebted: { position: borrowPosition(), rpc: rpc(), registry },
  blocked: [
    {
      name: "a debt whose asset balance the caller never supplied",
      position: borrowPosition(),
      rpc: rpc(),
      registry,
      ctx: { tokenBalances: {} },
      expectCodes: ["blend_repay_asset_balance_unknown"],
    },
    {
      name: "a debt the account cannot repay in full from its own balance",
      position: borrowPosition(),
      rpc: rpc(),
      registry,
      ctx: { tokenBalances: { [USDC]: "100000000" } },
      expectCodes: ["blend_repay_asset_missing"],
    },
  ],
  ctx,
});

async function run(
  state: Parameters<typeof fakeBlendDeps>[0],
  position: BlendPosition = supplyPosition(),
  context = ctx,
  registryLookup = registry
) {
  const deps = fakeBlendDeps(state);
  const result = await runExitAdapter(blendExitAdapter(deps), position, context, {
    rpc: rpc(),
    resolveWasmHash: registryLookup.resolveWasmHash,
    isRegistryFresh: () => true,
  });
  return { result, deps };
}

describe("blend exit adapter", () => {
  test("plans the whole pool position: every repay first, then collateral, then supply", async () => {
    const { result } = await run(INDEBTED, borrowPosition());
    expect(result.blockers).toEqual([]);
    expect(result.plan.map((s) => [s.kind, s.asset])).toEqual([
      ["repay", USDC],
      ["withdraw_collateral", XLM],
      ["withdraw", USDC],
    ]);
    expect(result.next?.step.kind).toBe("repay");
  });

  test("a repay asks for the debt plus the accrual margin, with what the account holds as ceiling", async () => {
    const { result } = await run(INDEBTED, borrowPosition());
    const repay = result.plan[0]!;
    expect(repay.amount).toBe(DEBT_ASK);
    expect(repay.ceiling).toBe("500000000");
    expect(repay.clampsToPosition).toBeUndefined();
  });

  test("a holding that covers the debt but not the margin is refused - a partial repay strands the collateral", async () => {
    // 10.205 USDC held: above the 10.2 read, below the 10.2102 the ledger will want.
    const tight = harnessContext({ tokenBalances: { [USDC]: "102050000" } });
    const { result } = await run(INDEBTED, borrowPosition(), tight);
    expect(result.next).toBeNull();
    expect(result.blockers.map((b) => b.code)).toEqual(["blend_repay_asset_missing"]);
    expect(result.blockers[0]!.message).toContain("52000 short");
  });

  test("withdrawals declare the live balance as ceiling and over-ask by the bounded margin", async () => {
    const { result } = await run(INDEBTED, borrowPosition());
    const [, collateral, supply] = result.plan;
    expect(collateral!.ceiling).toBe(COLLATERAL_UNDERLYING);
    expect(collateral!.amount).toBe(COLLATERAL_ASK);
    expect(collateral!.clampsToPosition).toBe(true);
    expect(supply!.ceiling).toBe(SUPPLY_UNDERLYING);
    expect(supply!.amount).toBe(SUPPLY_ASK);
  });

  test("a missing balance is 'unknown', never 'zero': the caller must supply what the account holds", async () => {
    const blind = harnessContext({ tokenBalances: {} });
    const { result } = await run(INDEBTED, borrowPosition(), blind);
    expect(result.blockers.map((b) => b.code)).toEqual(["blend_repay_asset_balance_unknown"]);
    const garbled = harnessContext({ tokenBalances: { [USDC]: "12.5" } });
    const bad = await run(INDEBTED, borrowPosition(), garbled);
    expect(bad.result.blockers.map((b) => b.code)).toEqual(["blend_repay_asset_balance_unknown"]);
  });

  test("health follows the plan: repaid debt is gone, a repay the plan forgot stays visible", async () => {
    const adapter = blendExitAdapter(fakeBlendDeps(INDEBTED));
    const live = await adapter.readLive(borrowPosition(), CODE, ctx, rpc());
    if (live.status !== "loaded") throw new Error("expected a loaded pool");
    const { steps } = adapter.plan(borrowPosition(), live, CODE, ctx);

    const planned = adapter.health(borrowPosition(), live, steps);
    expect(planned?.debtValue).toBe("0.0000000");
    expect(Number(planned?.collateralValue)).toBeCloseTo(47.25, 5);

    const forgot = adapter.health(
      borrowPosition(),
      live,
      steps.filter((s) => s.kind !== "repay")
    );
    expect(Number(forgot?.debtValue)).toBeCloseTo(11.22, 5);
    // ...and that is exactly what lets the runner's repay obligation fire from outside.
    expect(
      assessRepayPlanned(forgot!, ["withdraw_collateral", "withdraw"]).map((b) => b.code)
    ).toEqual(["withdraw_before_repay"]);
  });

  test("a position with no debt has no health to assess", async () => {
    const adapter = blendExitAdapter(fakeBlendDeps(SUPPLY_ONLY));
    const live = await adapter.readLive(supplyPosition(), CODE, ctx, rpc());
    if (live.status !== "loaded") throw new Error("expected a loaded pool");
    expect(adapter.health(supplyPosition(), live, [])).toBeNull();
  });

  test("loads the pool with the client for the version the registry resolved", async () => {
    const v1 = registryKnowing(POOL, WASM_HASH, "blend", "pool", "testnet", "v1");
    const { result, deps } = await run(
      { ...SUPPLY_ONLY, version: Version.V1 },
      supplyPosition(),
      ctx,
      v1
    );
    expect(deps.loadCalls).toEqual([`${POOL}@V1`]);
    expect(result.blockers).toEqual([]);
    expect(result.next?.step.kind).toBe("withdraw");
  });

  test("a registry version the SDK has no client for blocks without loading anything", async () => {
    const deps = fakeBlendDeps(SUPPLY_ONLY);
    const adapter = blendExitAdapter(deps);
    const code = { version: "v3", kind: "pool" as const };
    const live = await adapter.readLive(supplyPosition(), code, ctx, rpc());
    expect(live.status).toBe("unsupported_version");
    expect(deps.loadCalls).toEqual([]);
    expect(adapter.plan(supplyPosition(), live, code, ctx).blockers[0]!.code).toBe(
      "blend_pool_version_unsupported"
    );
  });

  test("a contract registered as something other than a pool blocks without loading anything", async () => {
    const deps = fakeBlendDeps(SUPPLY_ONLY);
    const adapter = blendExitAdapter(deps);
    const code = { version: "v2", kind: "backstop" as const };
    const live = await adapter.readLive(supplyPosition(), code, ctx, rpc());
    expect(live.status).toBe("not_pool");
    expect(deps.loadCalls).toEqual([]);
    expect(adapter.plan(supplyPosition(), live, code, ctx).blockers[0]!.code).toBe(
      "blend_contract_not_pool"
    );
  });

  test("a pool the SDK cannot read or price blocks for manual review, not retry", async () => {
    const throwing = {
      ...fakeBlendDeps(SUPPLY_ONLY),
      loadPool: async () => {
        throw new Error("scvMap malformed");
      },
    };
    const adapter = blendExitAdapter(throwing);
    const live = await adapter.readLive(supplyPosition(), CODE, ctx, rpc());
    expect(live.status).toBe("unreadable");
    const plan = adapter.plan(supplyPosition(), live, CODE, ctx);
    expect(plan.blockers[0]!.code).toBe("blend_pool_unreadable");
    expect(plan.blockers[0]!.message).not.toContain("etry");

    const unpriced = {
      ...fakeBlendDeps(INDEBTED),
      estimate: () => ({ totalEffectiveCollateral: Number.NaN, totalEffectiveLiabilities: 0 }),
    };
    const nan = await blendExitAdapter(unpriced).readLive(borrowPosition(), CODE, ctx, rpc());
    expect(nan.status).toBe("unreadable");
  });

  test("a position that vanished since detection blocks rather than planning nothing", async () => {
    const { result } = await run({});
    expect(result.next).toBeNull();
    expect(result.blockers.map((b) => b.code)).toEqual(["blend_position_gone"]);
  });

  test("backstop deposits are not this adapter's to exit", () => {
    const adapter = blendExitAdapter(fakeBlendDeps(SUPPLY_ONLY));
    expect(adapter.supports(supplyPosition({ isBackstop: true }))).toBe(false);
    expect(adapter.supports(supplyPosition())).toBe(true);
    expect(adapter.supports(borrowPosition())).toBe(true);
  });

  test("buildStep encodes a single submit request the way the contract expects it", async () => {
    const { result } = await run(INDEBTED, borrowPosition());
    if (!result.next || result.next.build.source !== "local") {
      throw new Error("expected a local build");
    }
    const op = result.next.build.op;
    const invocation = op.body().invokeHostFunctionOp().hostFunction().invokeContract();
    expect(Address.fromScAddress(invocation.contractAddress()).toString()).toBe(POOL);
    expect(invocation.functionName().toString()).toBe("submit");

    const [from, spender, to, requests] = invocation.args();
    for (const who of [from, spender, to]) {
      expect(Address.fromScVal(who!).toString()).toBe(ctx.account);
    }
    const decoded: unknown = scValToNative(requests!);
    expect(decoded).toEqual([
      { request_type: RequestType.Repay, address: USDC, amount: BigInt(DEBT_ASK) },
    ]);
    expect(result.next.intent.args[0]).toBe("Repay");
    expect(result.next.intent.recipient).toBe(ctx.account);
  });

  test("the request type follows the step kind: collateral leaves via WithdrawCollateral, supply via Withdraw", async () => {
    const adapter = blendExitAdapter(fakeBlendDeps(INDEBTED));
    const live = await adapter.readLive(borrowPosition(), CODE, ctx, rpc());
    if (live.status !== "loaded") throw new Error("expected a loaded pool");
    const { steps } = adapter.plan(borrowPosition(), live, CODE, ctx);
    const types = steps.map((step) => {
      const built = adapter.buildStep(step, live, ctx);
      if (built.build.source !== "local") throw new Error("expected a local build");
      const requests = built.build.op
        .body()
        .invokeHostFunctionOp()
        .hostFunction()
        .invokeContract()
        .args()[3]!;
      const [request] = scValToNative(requests) as Array<{ request_type: number }>;
      return request!.request_type;
    });
    expect(types).toEqual([
      RequestType.Repay,
      RequestType.WithdrawCollateral,
      RequestType.Withdraw,
    ]);
  });

  test("the built operation carries no source of its own - the closing account signs", async () => {
    const { result } = await run(SUPPLY_ONLY);
    if (!result.next || result.next.build.source !== "local") {
      throw new Error("expected a local build");
    }
    expect(result.next.build.op.sourceAccount()).toBeUndefined();
    const envelope = xdr.TransactionEnvelope.fromXDR(result.next.simulation.txXdr, "base64");
    expect(envelope.v1().tx().operations()).toHaveLength(1);
  });
});
