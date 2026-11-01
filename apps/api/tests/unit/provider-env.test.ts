import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// config/networks.ts reads process.env once at import time, so each case is its own process.

const src = join(import.meta.dir, "..", "..", "src", "config");

const COMPLETE = {
  API_KEYS: "ci=synthetic",
  MEDIATOR_SECRET_TESTNET: "synthetic",
  MEDIATOR_SECRET_MAINNET: "synthetic",
  FEE_ACCOUNT_SECRET_TESTNET: "synthetic",
  FEE_ACCOUNT_SECRET_MAINNET: "synthetic",
  SOROSWAP_API_KEY: "synthetic",
  OCTOPOS_API_KEY: "synthetic",
  ADMIN_API_TOKEN: "synthetic",
  FIRESTORE_PROJECT_ID: "synthetic",
  INTEGRATOR_AUTH_SECRET: "synthetic",
};

interface Report {
  problems: Array<{ variable: string; message: string }>;
  warnings: Array<{ variable: string; message: string }>;
  deprecated: string[];
  hosts: string[];
  rpc: Array<{ url: string; headers: Record<string, string> }>;
  horizon: Array<{ url: string; headers: Record<string, string> }>;
}

async function boot(env: Record<string, string>): Promise<Report> {
  const dir = mkdtempSync(join(tmpdir(), "lumenwipe-provider-env-"));
  try {
    const harness = join(dir, "harness.ts");
    writeFileSync(
      harness,
      [
        `import { deprecatedEnvWarnings, effectiveEndpointHosts, horizonProviders, rpcProviders } from "${src}/networks.ts";`,
        `import { checkEnv } from "${src}/validate-env.ts";`,
        "const { problems, warnings } = checkEnv();",
        "process.stdout.write(JSON.stringify({ problems, warnings,",
        "  deprecated: deprecatedEnvWarnings, hosts: effectiveEndpointHosts(),",
        '  rpc: rpcProviders("mainnet"), horizon: horizonProviders("mainnet") }));',
        "",
      ].join("\n")
    );
    const spawnEnv: Record<string, string | undefined> = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
    };
    const proc = Bun.spawn(["bun", "run", harness], {
      cwd: dir,
      env: { ...spawnEnv, ...COMPLETE, NODE_ENV: "production", ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    return JSON.parse(stdout) as Report;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the deployed environment keeps booting: only the legacy routing names, no new ones", async () => {
  const report = await boot({
    NEXT_PUBLIC_PATH_ROUTING_API_MAINNET: "https://routing-mainnet.test",
    NEXT_PUBLIC_PATH_ROUTING_API_TESTNET: "https://routing-testnet.test",
  });
  expect(report.problems).toEqual([]);
  expect(report.rpc).toHaveLength(1);
  expect(report.horizon).toHaveLength(1);
  expect(report.warnings.map((w) => w.variable)).toEqual(["STELLAR_RPC_MAINNET"]);
  expect(report.deprecated).toEqual([
    "NEXT_PUBLIC_PATH_ROUTING_API_MAINNET is deprecated - rename it to PATH_ROUTING_API_MAINNET.",
    "NEXT_PUBLIC_PATH_ROUTING_API_TESTNET is deprecated - rename it to PATH_ROUTING_API_TESTNET.",
  ]);
  expect(report.hosts).toEqual([
    "mainnet rpc endpoints: mainnet.sorobanrpc.com",
    "mainnet horizon endpoints: routing-mainnet.test",
    "testnet rpc endpoints: soroban-testnet.stellar.org",
    "testnet horizon endpoints: routing-testnet.test",
  ]);
});

test("a list is split in order, and each URL keeps only its own headers", async () => {
  const report = await boot({
    STELLAR_RPC_MAINNET: "https://rpc-a.test, https://rpc-b.test ,https://rpc-c.test",
    STELLAR_RPC_HEADER_NAME_MAINNET: "x-a",
    STELLAR_RPC_HEADER_VALUE_MAINNET: "synthetic-a",
    STELLAR_RPC_HEADER_NAME_MAINNET_3: "x-c",
    STELLAR_RPC_HEADER_VALUE_MAINNET_3: "synthetic-c",
    PATH_ROUTING_API_MAINNET: "https://h-a.test,https://h-b.test",
    PATH_ROUTING_API_HEADER_NAME_MAINNET_2: "x-h",
    PATH_ROUTING_API_HEADER_VALUE_MAINNET_2: "synthetic-h",
  });
  expect(report.problems).toEqual([]);
  expect(report.rpc).toEqual([
    { url: "https://rpc-a.test", headers: { "x-a": "synthetic-a" } },
    { url: "https://rpc-b.test", headers: {} },
    { url: "https://rpc-c.test", headers: { "x-c": "synthetic-c" } },
  ]);
  expect(report.horizon).toEqual([
    { url: "https://h-a.test", headers: {} },
    { url: "https://h-b.test", headers: { "x-h": "synthetic-h" } },
  ]);
});

test("a legacy list warns once however many URLs it holds", async () => {
  const report = await boot({
    NEXT_PUBLIC_STELLAR_RPC_MAINNET: "https://rpc-a.test,https://rpc-b.test",
    PATH_ROUTING_API_MAINNET: "https://h.test",
  });
  expect(report.deprecated).toEqual([
    "NEXT_PUBLIC_STELLAR_RPC_MAINNET is deprecated - rename it to STELLAR_RPC_MAINNET.",
  ]);
  expect(report.rpc).toHaveLength(2);
});

test("the boot log carries hostnames only, never a path, query, user info or header", async () => {
  const report = await boot({
    STELLAR_RPC_MAINNET:
      "https://user:synthetic-pass@rpc-a.test/v1/synthetic-path-key?token=synthetic-query," +
      "https://rpc-b.test/synthetic-second",
    STELLAR_RPC_HEADER_NAME_MAINNET: "x-synthetic-name",
    STELLAR_RPC_HEADER_VALUE_MAINNET: "synthetic-value",
    PATH_ROUTING_API_MAINNET: "https://h.test/synthetic-horizon-key",
  });
  expect(report.hosts).toContain("mainnet rpc endpoints: rpc-a.test, rpc-b.test");
  expect(report.hosts).toContain("mainnet horizon endpoints: h.test");
  const printed = JSON.stringify([report.hosts, report.problems, report.warnings]);
  expect(printed).not.toContain("synthetic");
});

test("an unconfigured list is logged as none, and a value that is no URL prints nothing of itself", async () => {
  const report = await boot({ STELLAR_RPC_TESTNET: "not-a-url-synthetic" });
  expect(report.hosts).toContain("mainnet horizon endpoints: none");
  expect(report.hosts).toContain("testnet rpc endpoints: invalid-url");
});
