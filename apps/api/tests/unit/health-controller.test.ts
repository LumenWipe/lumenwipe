import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Test } from "@nestjs/testing";
import { TerminusModule } from "@nestjs/terminus";
import { HealthController } from "@/health/health.controller";
import * as rpcModule from "@/lib/stellar/rpc";

// Wiring coverage for #59's "real health check" item: `/health/deep` (HealthController.deep())
// actually reflects whether Stellar RPC is reachable, on both networks independently, rather
// than always reporting a static "ok" - and does so without depending on real network access in
// CI, by mocking getRpcServer rather than hitting testnet/mainnet RPC for real.

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

test("reports up on every network when RPC responds", async () => {
  spyOn(rpcModule, "getRpcServer").mockReturnValue({
    getHealth: () => Promise.resolve({ status: "healthy" }),
  } as unknown as ReturnType<typeof rpcModule.getRpcServer>);

  const controller = await buildController();
  const result = await controller.deep();

  expect(result.status).toBe("ok");
  expect(result.details.rpc_testnet?.status).toBe("up");
  expect(result.details.rpc_mainnet?.status).toBe("up");
});

test("throws (503) when one network's RPC is unreachable, naming which one", async () => {
  spyOn(rpcModule, "getRpcServer").mockImplementation(((network: string) => ({
    getHealth: () =>
      network === "mainnet"
        ? Promise.reject(new Error("connection refused"))
        : Promise.resolve({ status: "healthy" }),
  })) as unknown as typeof rpcModule.getRpcServer);

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

test("reports down (not a hang or a crash) when RPC never responds", async () => {
  spyOn(rpcModule, "getRpcServer").mockReturnValue({
    getHealth: () => new Promise(() => {}), // never resolves
  } as unknown as ReturnType<typeof rpcModule.getRpcServer>);

  const controller = await buildController();
  let caught: unknown;
  try {
    await controller.deep();
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeDefined();
  const response = (caught as { getResponse: () => Record<string, unknown> }).getResponse();
  const details = response.details as Record<string, { status: string; message?: string }>;
  expect(details.rpc_testnet?.status).toBe("down");
  expect(details.rpc_testnet?.message).toContain("timed out");
}, 10_000);
