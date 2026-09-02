import { describe, expect, test } from "bun:test";
import { RequestType, Version } from "@blend-capital/blend-sdk";
import { Address, scValToNative, xdr } from "@stellar/stellar-sdk";
import type { BlendBorrowPosition, BlendSupplyPosition } from "@lumenwipe/types";
import { runExitAdapter } from "@/lib/defi-exits";
import { blendExitAdapter, type BlendPosition } from "@/lib/defi-exits/blend";
import {
  describeExitAdapterInvariants,
  harnessContext,
  registryKnowing,
} from "./fixtures/exit-adapter-harness";
import { fakeExitRpc } from "./fixtures/fake-exit-adapter";
import { USDC, XLM, fakeBlendDeps, withBuffer } from "./fixtures/fake-blend-pool";

// Sebas's registry entry for the official Blend V2 testnet pool, reused as the fixture address.
const POOL = "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF";
const WASM_HASH = "a41fc53d6753b6c04eb15b021c55052366a4c8e0e21bc72700f461264ec1350e";

const registry = registryKnowing(POOL, WASM_HASH, "blend", "pool", "testnet", "v2");
const ctx = harnessContext({ tokenBalances: { [USDC]: "500000000" } }); // holds 50 USDC
const rpc = (simulation: "ok" | "error" = "ok") =>
  fakeExitRpc({ liveWasmHash: WASM_HASH, liveBalance: "0", simulation });

function supplyPosition(bTokenAmount = "2000000000"): BlendSupplyPosition {
  return {
    protocol: "blend",
    positionType: "supply",
    contractAddress: POOL,
    assetAddress: USDC,
    bTokenAmount,
    usdValue: null,
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

// 100 USDC of bTokens -> 105 USDC underlying -> over-asked to 105.105.
const SUPPLY_ONLY = { supply: { [USDC]: 1_000_000_000n } };
const SUPPLY_LIVE_CEILING = withBuffer(1_050_000_000n);

// 500 XLM collateral (525 underlying, $47.25 effective) against 10 USDC of dTokens
// (10.2 underlying, $11.22 effective): healthy, and the account holds enough USDC to repay.
const INDEBTED = {
  collateral: { [XLM]: 5_000_000_000n },
  liabilities: { [USDC]: 100_000_000n },
  supply: { [USDC]: 1_000_000_000n },
};

describeExitAdapterInvariants("blend", {
  adapter: blendExitAdapter(fakeBlendDeps(SUPPLY_ONLY)),
  healthy: {
    position: supplyPosition(),
    rpc: rpc(),
    registry,
    detectedAmount: "2000000000",
    liveCeiling: SUPPLY_LIVE_CEILING,
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
    detectedAmount: "2000000000",
    liveCeiling: { [USDC]: SUPPLY_LIVE_CEILING, [XLM]: withBuffer(5_250_000_000n) },
  },
  simulationFails: { position: borrowPosition(), rpc: rpc("error"), registry },
  indebted: { position: borrowPosition(), rpc: rpc(), registry },
  blocked: [
    {
      name: "a debt the account cannot repay from its own balance",
      position: borrowPosition(),
      rpc: rpc(),
      registry,
      ctx: { tokenBalances: {} },
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

  test("a repay over-asks by the accrual buffer but never beyond what the account holds", async () => {
    const { result } = await run(INDEBTED, borrowPosition());
    const repay = result.plan[0]!;
    // 10 USDC of dTokens -> 10.2 underlying -> 10.2102 asked; the account holds 50, so the ask stands.
    expect(repay.amount).toBe(withBuffer(102_000_000n));
    expect(repay.ceiling).toBe("500000000");

    // 10.205 USDC held: enough to cover the 10.2 owed, less than the 10.2102 over-ask - so the
    // repay spends everything the account has and no more.
    const tight = harnessContext({ tokenBalances: { [USDC]: "102050000" } });
    const capped = await run(INDEBTED, borrowPosition(), tight);
    expect(capped.result.plan[0]!.amount).toBe("102050000");
    expect(capped.result.plan[0]!.ceiling).toBe("102050000");
  });

  test("withdrawals over-ask by the accrual buffer so the protocol's clamp leaves no dust", async () => {
    const { result } = await run(INDEBTED, borrowPosition());
    const [, collateral, supply] = result.plan;
    expect(collateral!.amount).toBe(withBuffer(5_250_000_000n));
    expect(collateral!.ceiling).toBe(collateral!.amount);
    expect(supply!.amount).toBe(withBuffer(1_050_000_000n));
  });

  test("a debt the account cannot cover blocks with the shortfall, and nothing else is planned", async () => {
    const short = harnessContext({ tokenBalances: { [USDC]: "100000000" } }); // 10 < 10.2 owed
    const { result } = await run(INDEBTED, borrowPosition(), short);
    expect(result.next).toBeNull();
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0]!.code).toBe("blend_repay_asset_missing");
    expect(result.blockers[0]!.message).toContain("2000000 short");
  });

  test("health reports the post-repay state, so a fully repaid position is not blocked by its current debt", async () => {
    const adapter = blendExitAdapter(fakeBlendDeps(INDEBTED));
    const live = await adapter.readLive(
      borrowPosition(),
      { version: "v2", kind: "pool" },
      ctx,
      rpc()
    );
    if (live.status !== "loaded") throw new Error("expected a loaded pool");
    expect(live.current.totalEffectiveLiabilities).toBeGreaterThan(0);
    const health = adapter.health(borrowPosition(), live, []);
    expect(health?.debtValue).toBe("0.0000000");
    expect(Number(health?.collateralValue)).toBeCloseTo(47.25, 5);
  });

  test("a position with no debt has no health to assess", async () => {
    const adapter = blendExitAdapter(fakeBlendDeps(SUPPLY_ONLY));
    const live = await adapter.readLive(
      supplyPosition(),
      { version: "v2", kind: "pool" },
      ctx,
      rpc()
    );
    if (live.status !== "loaded") throw new Error("expected a loaded pool");
    expect(adapter.health(supplyPosition(), live, [])).toBeNull();
  });

  test("loads the pool with the client for the version the registry resolved", async () => {
    const v1 = registryKnowing(POOL, WASM_HASH, "blend", "pool", "testnet", "v1");
    const deps = fakeBlendDeps({ ...SUPPLY_ONLY, version: Version.V1 });
    const adapter = blendExitAdapter(deps);
    const live = await adapter.readLive(
      supplyPosition(),
      { version: "V1", kind: "pool" },
      ctx,
      rpc()
    );
    expect(deps.loadCalls).toEqual([`${POOL}@V1`]);
    if (live.status !== "loaded") throw new Error("expected a loaded pool");
    const plan = adapter.plan(supplyPosition(), live, { version: "V1", kind: "pool" }, ctx);
    expect(plan.blockers).toEqual([]);
    expect(v1.resolveWasmHash("testnet", WASM_HASH).status).toBe("known");
  });

  test("a registry version the SDK has no client for blocks instead of guessing", async () => {
    const adapter = blendExitAdapter(fakeBlendDeps(SUPPLY_ONLY));
    const live = await adapter.readLive(
      supplyPosition(),
      { version: "v3", kind: "pool" },
      ctx,
      rpc()
    );
    expect(live.status).toBe("unsupported_version");
    const plan = adapter.plan(supplyPosition(), live, { version: "v3", kind: "pool" }, ctx);
    expect(plan.steps).toEqual([]);
    expect(plan.blockers[0]!.code).toBe("blend_pool_version_unsupported");
  });

  test("a pool that reports a different version than the registry blocks", async () => {
    const adapter = blendExitAdapter(fakeBlendDeps({ ...SUPPLY_ONLY, version: Version.V1 }));
    const live = await adapter.readLive(
      supplyPosition(),
      { version: "v2", kind: "pool" },
      ctx,
      rpc()
    );
    const plan = adapter.plan(supplyPosition(), live, { version: "v2", kind: "pool" }, ctx);
    expect(plan.blockers[0]!.code).toBe("blend_pool_version_mismatch");
  });

  test("a contract registered as something other than a pool blocks", async () => {
    const adapter = blendExitAdapter(fakeBlendDeps(SUPPLY_ONLY));
    const live = await adapter.readLive(
      supplyPosition(),
      { version: "v2", kind: "backstop" },
      ctx,
      rpc()
    );
    const plan = adapter.plan(supplyPosition(), live, { version: "v2", kind: "backstop" }, ctx);
    expect(plan.blockers[0]!.code).toBe("blend_contract_not_pool");
  });

  test("a position that vanished since detection blocks rather than planning nothing", async () => {
    const { result } = await run({});
    expect(result.next).toBeNull();
    expect(result.blockers.map((b) => b.code)).toEqual(["blend_position_gone"]);
  });

  test("buildStep encodes a single submit request the way the contract expects it", async () => {
    const { result } = await run(INDEBTED, borrowPosition());
    if (!result.next || result.next.build.source !== "local")
      throw new Error("expected a local build");
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
      { request_type: RequestType.Repay, address: USDC, amount: BigInt(result.next.step.amount) },
    ]);
    expect(result.next.intent.args[0]).toBe("Repay");
    expect(result.next.intent.recipient).toBe(ctx.account);
  });

  test("the request type follows the step kind: collateral leaves via WithdrawCollateral, supply via Withdraw", async () => {
    const adapter = blendExitAdapter(fakeBlendDeps(INDEBTED));
    const live = await adapter.readLive(
      borrowPosition(),
      { version: "v2", kind: "pool" },
      ctx,
      rpc()
    );
    if (live.status !== "loaded") throw new Error("expected a loaded pool");
    const { steps } = adapter.plan(borrowPosition(), live, { version: "v2", kind: "pool" }, ctx);
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
    if (!result.next || result.next.build.source !== "local")
      throw new Error("expected a local build");
    expect(result.next.build.op.sourceAccount()).toBeUndefined();
    const envelope = xdr.TransactionEnvelope.fromXDR(result.next.simulation.txXdr, "base64");
    expect(envelope.v1().tx().operations()).toHaveLength(1);
  });
});
