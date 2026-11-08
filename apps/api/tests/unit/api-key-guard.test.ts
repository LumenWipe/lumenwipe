import { describe, expect, test } from "bun:test";
import { HttpException, UnauthorizedException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { ApiKeyDirectory, ResolvedApiKey } from "@/auth/api-key-directory";
import { ApiKeyGuard } from "@/auth/api-key.guard";
import { NetworkAgnostic } from "@/auth/network-agnostic.decorator";
import { Public } from "@/auth/public.decorator";
import type { KeyActivityService } from "@/metering/key-activity.service";

class Routes {
  keyed(): void {}
  @NetworkAgnostic()
  agnostic(): void {}
  @Public()
  open(): void {}
}

const TESTNET_KEY: ResolvedApiKey = {
  label: "GOWNER",
  rateLimit: null,
  id: "a".repeat(64),
  networks: ["testnet"],
};
const UNSCOPED_KEY: ResolvedApiKey = { ...TESTNET_KEY, networks: null };
const STATIC_KEY: ResolvedApiKey = { label: "web", rateLimit: null, id: null, networks: null };

function setup(resolved: ResolvedApiKey | null) {
  const touched: string[] = [];
  const directory = { resolve: async () => resolved } as unknown as ApiKeyDirectory;
  const activity = { touch: (id: string) => touched.push(id) } as unknown as KeyActivityService;
  const guard = new ApiKeyGuard(new Reflector(), directory, activity);
  const run = (handler: keyof Routes, params: Record<string, string> = {}) => {
    const req: Record<string, unknown> = {
      headers: { authorization: "Bearer lw_anything" },
      params,
    };
    const context = {
      getHandler: () => Routes.prototype[handler],
      getClass: () => Routes,
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    return { req, result: guard.canActivate(context) };
  };
  return { run, touched };
}

async function codeOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    expect(e).toBeInstanceOf(HttpException);
    return ((e as HttpException).getResponse() as { error: { code: string } }).error.code;
  }
}

describe("ApiKeyGuard network scope", () => {
  test("a testnet key is refused on mainnet and is not recorded as used", async () => {
    const { run, touched } = setup(TESTNET_KEY);
    const { req, result } = run("keyed", { network: "mainnet" });
    expect(await codeOf(result)).toBe("key_network_not_allowed");
    expect(req.apiKeyLabel).toBeUndefined();
    expect(touched).toEqual([]);
  });

  test("the refusal is a 403", async () => {
    const { run } = setup(TESTNET_KEY);
    const error = await run("keyed", { network: "mainnet" }).result.catch((e: unknown) => e);
    expect((error as HttpException).getStatus()).toBe(403);
  });

  test("a testnet key passes on testnet and is recorded as used", async () => {
    const { run, touched } = setup(TESTNET_KEY);
    const { req, result } = run("keyed", { network: "testnet" });
    expect(await result).toBe(true);
    expect(req.apiKeyLabel).toBe("GOWNER");
    expect(req.apiKeyId).toBe(TESTNET_KEY.id!);
    expect(touched).toEqual([TESTNET_KEY.id!]);
  });

  test("a scoped key fails closed on a network value it does not list", async () => {
    const { run } = setup(TESTNET_KEY);
    expect(await codeOf(run("keyed", { network: "futurenet" }).result)).toBe(
      "key_network_not_allowed"
    );
  });

  test("a scoped key is refused on a keyed route without a network unless it is agnostic", async () => {
    const { run } = setup(TESTNET_KEY);
    expect(await codeOf(run("keyed").result)).toBe("key_network_not_allowed");
    expect(await run("agnostic").result).toBe(true);
  });

  test("an unscoped key passes on every network and on routes without one", async () => {
    const { run } = setup(UNSCOPED_KEY);
    expect(await run("keyed", { network: "mainnet" }).result).toBe(true);
    expect(await run("keyed", { network: "testnet" }).result).toBe(true);
    expect(await run("keyed").result).toBe(true);
  });

  test("a manually provisioned key is unscoped and never recorded as used", async () => {
    const { run, touched } = setup(STATIC_KEY);
    const { req, result } = run("keyed", { network: "mainnet" });
    expect(await result).toBe(true);
    expect(req.apiKeyId).toBeUndefined();
    expect(touched).toEqual([]);
  });

  test("an unknown key is still a 401 before any scope check", async () => {
    const { run } = setup(null);
    expect(run("keyed", { network: "mainnet" }).result).rejects.toBeInstanceOf(
      UnauthorizedException
    );
  });

  test("a public route needs no key", async () => {
    const { run } = setup(null);
    expect(await run("open", { network: "mainnet" }).result).toBe(true);
  });
});
