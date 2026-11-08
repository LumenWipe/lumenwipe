import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { checkoutRoot, isInside, LabRefusal } from "../src/home";
import {
  assertNodeStripsTypes,
  childEnv,
  PUBLIC_PROVIDERS,
  startLocalApi,
  throwawayApiKey,
} from "../src/local-api";

describe("the local API environment", () => {
  test("holds only the keys the lab sets, nothing from the shell", () => {
    process.env.LAB_TEST_SHELL_ONLY = "leak";
    const env = childEnv({ port: 4100, apiKey: "throwaway", spansFile: "/tmp/spans.jsonl" });
    delete process.env.LAB_TEST_SHELL_ONLY;
    expect(Object.keys(env).sort()).toEqual(
      [
        "API_KEYS",
        "LUMENWIPE_LAB_SPANS",
        "LUMENWIPE_LAB_UPSTREAMS",
        "NODE_ENV",
        "PORT",
        ...Object.keys(PUBLIC_PROVIDERS),
      ].sort()
    );
    expect(env.API_KEYS).toBe("lab=throwaway");
    expect(JSON.parse(env.LUMENWIPE_LAB_UPSTREAMS)).toEqual({
      "https://soroban-rpc.testnet.stellar.gateway.fm": "rpc",
      "https://soroban-testnet.stellar.org": "rpc",
      "https://mainnet.sorobanrpc.com": "rpc",
      "https://horizon-testnet.stellar.org": "horizon",
      "https://horizon.stellar.org": "horizon",
    });
  });

  test("takes provider endpoints and their keys from config, and nothing else", () => {
    const env = childEnv({
      port: 4100,
      apiKey: "k",
      spansFile: "/tmp/s",
      overrides: {
        STELLAR_RPC_MAINNET: "https://rpc.example.org",
        STELLAR_RPC_HEADER_NAME_MAINNET: "x-key",
        STELLAR_RPC_HEADER_VALUE_MAINNET: "v",
      },
    });
    expect(env.STELLAR_RPC_MAINNET).toBe("https://rpc.example.org");
    for (const name of [
      "API_KEYS",
      "MEDIATOR_SECRET_MAINNET",
      "FEE_ACCOUNT_SECRET_TESTNET",
      "PATH",
    ]) {
      expect(() =>
        childEnv({ port: 1, apiKey: "k", spansFile: "/tmp/s", overrides: { [name]: "x" } })
      ).toThrow(LabRefusal);
    }
  });

  test("uses a fresh key per run", () => {
    expect(throwawayApiKey()).not.toBe(throwawayApiKey());
    expect(throwawayApiKey()).toMatch(/^lab_[A-Za-z0-9_-]{32}$/);
  });
});

describe("the Node version", () => {
  test("must strip types by default, so the preload loads", () => {
    for (const ok of ["v22.18.0", "v22.23.4", "v23.6.0", "v24.0.0", "v26.13.0"]) {
      expect(() => assertNodeStripsTypes(ok)).not.toThrow();
    }
    for (const bad of ["v22.12.0", "v22.17.9", "v23.5.0", "v20.19.0", ""]) {
      expect(() => assertNodeStripsTypes(bad)).toThrow(LabRefusal);
    }
  });
});

describe("startLocalApi", () => {
  test("runs the API from an empty folder outside the checkout with exactly the given env", async () => {
    let seen:
      { command: string; args: string[]; cwd: string; env: Record<string, string> } | undefined;
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null,
      stderr: new EventEmitter(),
      kill() {
        child.exitCode = 0;
        child.emit("exit");
        return true;
      },
    });
    const api = await startLocalApi({
      node: "/usr/bin/node",
      mainJs: "/repo/apps/api/dist/main.js",
      recorder: "/repo/tools/lab/src/span-recorder.ts",
      envFor: (spansFile) => ({ PORT: "4123", LUMENWIPE_LAB_SPANS: spansFile }),
      spawnProcess: (command, args, options) => {
        seen = { command, args, ...options };
        return child as unknown as ChildProcess;
      },
      fetchImpl: (async () => new Response("ok")) as unknown as typeof fetch,
    });
    expect(seen?.args).toEqual([
      "--import",
      "/repo/tools/lab/src/span-recorder.ts",
      "/repo/apps/api/dist/main.js",
    ]);
    expect(isInside(seen!.cwd, checkoutRoot())).toBe(false);
    expect(seen?.env).toEqual({ PORT: "4123", LUMENWIPE_LAB_SPANS: `${seen!.cwd}/spans.jsonl` });
    expect(api.baseUrl).toBe("http://127.0.0.1:4123");
    expect(api.spans()).toEqual([]);
    await api.stop();
    expect(existsSync(seen!.cwd)).toBe(false);
  });
});
