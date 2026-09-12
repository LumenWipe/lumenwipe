import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Test } from "@nestjs/testing";
import { TerminusModule } from "@nestjs/terminus";
import { HealthController } from "@/health/health.controller";
import * as rpcModule from "@/lib/stellar/rpc";
import {
  resetDegradedFallbackCount,
  resolveDefiPositions,
} from "@/lib/defi-positions/resolve-defi-positions";

// Wiring coverage for #59's "real health check" item: `/health/deep` (HealthController.deep())
// actually reflects whether Stellar RPC is reachable, on both networks independently, rather
// than always reporting a static "ok" - and does so without depending on real network access in
// CI, by mocking buildRpcServer rather than hitting testnet/mainnet RPC for real.

async function buildController(): Promise<HealthController> {
  const moduleRef = await Test.createTestingModule({
    imports: [TerminusModule.forRoot()],
    controllers: [HealthController],
  }).compile();
  return moduleRef.get(HealthController);
}

afterEach(() => {
  mock.restore();
});

test("check() reports the DeFi degraded-fallback count alongside the Horizon rate-limit count", async () => {
  resetDegradedFallbackCount();
  await resolveDefiPositions(
    "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3",
    "mainnet",
    {
      octopos: { baseUrl: "" },
      directRead: {
        rpc: { getLedgerEntries: () => Promise.resolve({ entries: [] }) } as never,
        registryEntries: [],
      },
    }
  );

  const controller = await buildController();
  const result = controller.check();

  expect(result.status).toBe("ok");
  expect(result.defiDegradedFallbackCount).toBe(1);
  expect(typeof result.upstreamRateLimitHits).toBe("number");
});

test("reports up on every network when RPC responds", async () => {
  spyOn(rpcModule, "buildRpcServer").mockReturnValue({
    getHealth: () => Promise.resolve({ status: "healthy" }),
  } as unknown as ReturnType<typeof rpcModule.buildRpcServer>);

  const controller = await buildController();
  const result = await controller.deep();

  expect(result.status).toBe("ok");
  expect(result.details.rpc_testnet?.status).toBe("up");
  expect(result.details.rpc_mainnet?.status).toBe("up");
});

test("throws (503) when one network's RPC is unreachable, naming which one", async () => {
  spyOn(rpcModule, "buildRpcServer").mockImplementation(((network: string) => ({
    getHealth: () =>
      network === "mainnet"
        ? Promise.reject(new Error("connection refused"))
        : Promise.resolve({ status: "healthy" }),
  })) as unknown as typeof rpcModule.buildRpcServer);

  const controller = await buildController();
  let caught: unknown;
  try {
    await controller.deep();
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeDefined();
  const response = (caught as { getResponse: () => Record<string, unknown> }).getResponse();
  expect((response.details as Record<string, { status: string }>).rpc_mainnet?.status).toBe("down");
  expect((response.details as Record<string, { status: string }>).rpc_testnet?.status).toBe("up");
});

test("uses a dedicated, short-timeout server per network - never the shared transaction-building singleton", async () => {
  const buildSpy = spyOn(rpcModule, "buildRpcServer").mockReturnValue({
    getHealth: () => Promise.resolve({ status: "healthy" }),
  } as unknown as ReturnType<typeof rpcModule.buildRpcServer>);
  const getSpy = spyOn(rpcModule, "getRpcServer");

  const controller = await buildController();
  await controller.deep();

  expect(getSpy).not.toHaveBeenCalled();
  expect(buildSpy).toHaveBeenCalledWith("testnet", { timeout: expect.any(Number) });
  expect(buildSpy).toHaveBeenCalledWith("mainnet", { timeout: expect.any(Number) });
});

test("coalesces requests within the cache window into one shared result, without re-hitting RPC", async () => {
  const buildSpy = spyOn(rpcModule, "buildRpcServer").mockReturnValue({
    getHealth: () => Promise.resolve({ status: "healthy" }),
  } as unknown as ReturnType<typeof rpcModule.buildRpcServer>);

  const controller = await buildController();
  const [first, second] = await Promise.all([controller.deep(), controller.deep()]);

  expect(first).toBe(second);
  // One call per network (testnet + mainnet), not one per request - a public, unthrottled
  // route that fanned out a fresh RPC call per inbound request would be free amplification
  // against the configured providers (#59's review flagged this).
  expect(buildSpy).toHaveBeenCalledTimes(2);
});
