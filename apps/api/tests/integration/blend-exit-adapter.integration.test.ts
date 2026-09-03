import { expect, test } from "bun:test";
import { Version } from "@blend-capital/blend-sdk";
import { Keypair } from "@stellar/stellar-sdk";
import { blendExitAdapter, defaultBlendDeps } from "@/lib/defi-exits/blend";
import { entriesForProtocol } from "@/lib/contract-registry";
import { harnessContext } from "../unit/fixtures/exit-adapter-harness";
import { fakeExitRpc } from "../unit/fixtures/fake-exit-adapter";

// Calls the real, live Stellar testnet RPC through the real Blend SDK - the only exercise of the
// path every unit test replaces with a stand-in (PoolV2.load, the oracle, PositionsEstimate). The
// package's `test` script never picks this up; `bun run test:integration` sets the opt-in flag.
const RUN_INTEGRATION = !!process.env.LUMENWIPE_RUN_INTEGRATION;

const pool = entriesForProtocol("testnet", "blend").find((e) => e.kind === "pool");

test.skipIf(!RUN_INTEGRATION)(
  "the registry's Blend testnet pool loads through the SDK with priced reserves",
  async () => {
    if (!pool) throw new Error("registry has no Blend testnet pool");
    const loaded = await defaultBlendDeps.loadPool("testnet", pool.address, Version.V2);
    expect(loaded.version).toBe(Version.V2);
    expect(loaded.reserves.size).toBeGreaterThan(0);
    const oracle = await loaded.loadOracle();
    const user = await loaded.loadUser(Keypair.random().publicKey());
    const estimate = defaultBlendDeps.estimate(loaded, oracle, user.positions);
    expect(Number.isFinite(estimate.totalEffectiveCollateral)).toBe(true);
    expect(Number.isFinite(estimate.totalEffectiveLiabilities)).toBe(true);
  },
  60_000
);

test.skipIf(!RUN_INTEGRATION)(
  "the pool's backstop reads through the SDK: an account with no deposit holds nothing, queues nothing",
  async () => {
    if (!pool) throw new Error("registry has no Blend testnet pool");
    const loaded = await defaultBlendDeps.loadPool("testnet", pool.address, Version.V2);
    const backstop = await defaultBlendDeps.loadBackstop(
      "testnet",
      Version.V2,
      loaded.metadata.backstop,
      pool.address,
      Keypair.random().publicKey(),
      Math.floor(Date.now() / 1000)
    );
    expect(backstop.contract).toBe(loaded.metadata.backstop);
    expect(backstop.backstopToken).toMatch(/^C[A-Z2-7]{55}$/);
    expect(backstop.blndToken).toMatch(/^C[A-Z2-7]{55}$/);
    expect(backstop).toMatchObject({ shares: 0n, queued: [], unlocked: 0n, emissions: 0n });
    const emissions = defaultBlendDeps.emissions(
      loaded,
      await loaded.loadUser(Keypair.random().publicKey()),
      Math.floor(Date.now() / 1000)
    );
    expect(emissions.claimable.size).toBe(0);
    expect(emissions.rateScaled).toBe(0n);
  },
  60_000
);

test.skipIf(!RUN_INTEGRATION)(
  "an account with nothing in the pool reads clean and plans a 'position gone' blocker",
  async () => {
    if (!pool) throw new Error("registry has no Blend testnet pool");
    const adapter = blendExitAdapter();
    const ctx = harnessContext({ tokenBalances: {} });
    const code = { version: pool.version, kind: pool.kind };
    const position = {
      protocol: "blend" as const,
      positionType: "supply" as const,
      contractAddress: pool.address,
      assetAddress: pool.address,
      bTokenAmount: "1",
      usdValue: null,
    };
    const live = await adapter.readLive(
      position,
      code,
      ctx,
      fakeExitRpc({ liveWasmHash: null, liveBalance: "0" })
    );
    expect(live.status).toBe("loaded");
    if (live.status !== "loaded") return;
    expect(live.positions).toEqual([]);
    expect(adapter.plan(position, live, code, ctx).blockers[0]!.code).toBe("exit_position_gone");
  },
  60_000
);
