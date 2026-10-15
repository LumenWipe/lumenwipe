import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { TerminusModule } from "@nestjs/terminus";
import { HealthController } from "@/health/health.controller";
import { registryDaysRemaining } from "@/lib/exchange-registry";
import * as rpcModule from "@/lib/stellar/rpc";
import {
  resetDegradedFallbackCount,
  resolveDefiPositions,
} from "@/lib/defi-positions/resolve-defi-positions";
import { defiPositionsDepsFor } from "@/lib/stellar/account-state";

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

// Every degraded-mode occurrence looks identical from the account read alone, whether OctoPos
// is having a real outage or was simply never given a baseUrl on this deployment - and the two
// call for very different follow-up. This makes "was OctoPos ever wired up on this process at
// all" a plain, static fact instead of something that requires reading Cloud Run logs to learn.
test("check() reports whether octopos is configured on this deployment", async () => {
  const controller = await buildController();
  const result = controller.check();

  expect(result.octoposConfigured).toBe(defiPositionsDepsFor().octopos.baseUrl !== "");
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

test("reports the exchange registry days remaining without failing the probe", async () => {
  spyOn(rpcModule, "buildRpcServer").mockReturnValue({
    getHealth: () => Promise.resolve({ status: "healthy" }),
  } as unknown as ReturnType<typeof rpcModule.buildRpcServer>);

  const controller = await buildController();
  const result = await controller.deep();

  expect(result.details.exchange_registry?.status).toBe("up");
  expect(result.details.exchange_registry?.daysRemaining).toBe(registryDaysRemaining());
  expect(Object.keys(result.details.exchange_registry ?? {}).sort()).toEqual([
    "daysRemaining",
    "status",
  ]);
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

async function deepFailure(controller: HealthController): Promise<Record<string, unknown>> {
  try {
    await controller.deep();
  } catch (error) {
    return (error as { getResponse: () => Record<string, unknown> }).getResponse();
  }
  throw new Error("expected deep() to fail");
}

const PROVIDER_ERROR =
  "request to https://rpc.example.net/v1/k3yInPath0123456789?apikey=q7uerySecret failed, reason: ECONNREFUSED";

test("a failed RPC probe reports only a fixed status and latency, never the upstream error text", async () => {
  spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  spyOn(rpcModule, "buildRpcServer").mockImplementation(((network: string) => ({
    getHealth: () =>
      network === "mainnet"
        ? Promise.reject(new Error(PROVIDER_ERROR))
        : Promise.resolve({ status: "healthy" }),
  })) as unknown as typeof rpcModule.buildRpcServer);

  const response = await deepFailure(await buildController());
  const details = response.details as Record<string, Record<string, unknown>>;

  expect(Object.keys(details.rpc_mainnet ?? {}).sort()).toEqual([
    "message",
    "responseTime",
    "status",
  ]);
  expect(details.rpc_mainnet?.message).toBe("unreachable");
  expect(typeof details.rpc_mainnet?.responseTime).toBe("number");
  expect(typeof details.rpc_testnet?.responseTime).toBe("number");
  const body = JSON.stringify(response);
  for (const leaked of ["k3yInPath", "q7uerySecret", "rpc.example.net", "ECONNREFUSED", "http"]) {
    expect(body).not.toContain(leaked);
  }
});

test("a non-Error rejection is reported with the same fixed status", async () => {
  spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  spyOn(rpcModule, "buildRpcServer").mockReturnValue({
    getHealth: () => Promise.reject(PROVIDER_ERROR),
  } as unknown as ReturnType<typeof rpcModule.buildRpcServer>);

  const response = await deepFailure(await buildController());
  const details = response.details as Record<string, Record<string, unknown>>;

  expect(details.rpc_testnet?.message).toBe("unreachable");
  expect(details.rpc_mainnet?.message).toBe("unreachable");
  expect(JSON.stringify(response)).not.toContain("q7uerySecret");
});

test("a probe that runs out its timeout reports timeout", async () => {
  spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  let clock = 1_000_000;
  spyOn(Date, "now").mockImplementation(() => clock);
  spyOn(rpcModule, "buildRpcServer").mockImplementation(((network: string) => ({
    getHealth: () =>
      network === "mainnet"
        ? Promise.resolve().then(() => {
            clock += 60_000;
            throw new Error(PROVIDER_ERROR);
          })
        : Promise.resolve({ status: "healthy" }),
  })) as unknown as typeof rpcModule.buildRpcServer);

  const response = await deepFailure(await buildController());
  const details = response.details as Record<string, Record<string, unknown>>;

  expect(details.rpc_mainnet?.message).toBe("timeout");
  expect(details.rpc_mainnet?.responseTime).toBe(60_000);
});

test("the upstream detail is logged with the provider reduced to its host", async () => {
  const warn = spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  spyOn(rpcModule, "buildRpcServer").mockImplementation(((network: string) => ({
    getHealth: () =>
      network === "mainnet"
        ? Promise.reject(new Error(PROVIDER_ERROR))
        : Promise.resolve({ status: "healthy" }),
  })) as unknown as typeof rpcModule.buildRpcServer);

  await deepFailure(await buildController());

  const logged = warn.mock.calls.map((call) => String(call[0])).join("\n");
  expect(logged).toContain("rpc_mainnet");
  expect(logged).toContain("rpc.example.net");
  expect(logged).toContain("ECONNREFUSED");
  expect(logged).not.toContain("k3yInPath");
  expect(logged).not.toContain("q7uerySecret");
});
