import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Coverage for #59: apps/api's config/networks.ts inherited NEXT_PUBLIC_-prefixed env var
// names from apps/web, where the prefix means something (Next.js build-time inlining) - it
// means nothing in this standalone service. Renamed to un-prefixed names with the old ones
// still read as a fallback, so an already-deployed environment keeps working. Each spawns a
// real child process (same pattern as env.test.ts's #88 coverage) because config/networks.ts
// reads process.env in top-level const initializers, evaluated once at import time - a normal
// in-process test can't observe two different env states across two imports of the same module.

const networksPath = join(import.meta.dir, "..", "..", "src", "config", "networks.ts");

// Every env key any test below might set or rely on being absent - cleared to "" by default so
// no test is at the mercy of whatever happens to be exported in the outer process's environment.
const ALL_TESTED_KEYS = [
  "NEXT_PUBLIC_PATH_ROUTING_API_TESTNET",
  "PATH_ROUTING_API_TESTNET",
  "NEXT_PUBLIC_STELLAR_RPC_TESTNET",
  "STELLAR_RPC_TESTNET",
  "NEXT_PUBLIC_MEDIATOR_PUBLIC_TESTNET",
  "MEDIATOR_PUBLIC_TESTNET",
] as const;

async function runHarness(
  dir: string,
  exportName: string,
  env: Record<string, string>
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const harnessPath = join(dir, "harness.ts");
  writeFileSync(
    harnessPath,
    [
      `import { ${exportName}, deprecatedEnvWarnings } from "${networksPath}";`,
      `process.stdout.write(JSON.stringify({ value: ${exportName}.testnet, warnings: deprecatedEnvWarnings }));`,
      "",
    ].join("\n")
  );
  // Deleted, not set to "" - `readEnv`'s fix treats a key merely being PRESENT (even empty) as
  // a deliberate override, so clearing by emptying it here would defeat the very fallback these
  // tests exercise. Start from the real environment (for PATH etc.), drop every tested key so
  // none of the outer test process's own env leaks in, then apply only what this call passes.
  const spawnEnv: Record<string, string | undefined> = { ...process.env };
  for (const key of ALL_TESTED_KEYS) delete spawnEnv[key];
  const proc = Bun.spawn(["bun", "run", harnessPath], {
    cwd: dir,
    env: { ...spawnEnv, ...env, NODE_ENV: "test" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "lumenwipe-networks-env-"));
}

test("the new, un-prefixed name is read directly with no deprecation warning", async () => {
  const dir = tempDir();
  try {
    const { stdout, stderr, exitCode } = await runHarness(dir, "PATH_ROUTING_API_URLS", {
      PATH_ROUTING_API_TESTNET: "https://new-name.test",
    });
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({ value: "https://new-name.test", warnings: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the old NEXT_PUBLIC_-prefixed name still works, with a deprecation warning naming it", async () => {
  const dir = tempDir();
  try {
    const { stdout, stderr, exitCode } = await runHarness(dir, "PATH_ROUTING_API_URLS", {
      NEXT_PUBLIC_PATH_ROUTING_API_TESTNET: "https://legacy-name.test",
    });
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const parsed = JSON.parse(stdout);
    expect(parsed.value).toBe("https://legacy-name.test");
    expect(parsed.warnings).toEqual([
      "NEXT_PUBLIC_PATH_ROUTING_API_TESTNET is deprecated - rename it to PATH_ROUTING_API_TESTNET.",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the new name wins when both are set, and no warning fires", async () => {
  const dir = tempDir();
  try {
    const { stdout, stderr, exitCode } = await runHarness(dir, "PATH_ROUTING_API_URLS", {
      PATH_ROUTING_API_TESTNET: "https://new-name.test",
      NEXT_PUBLIC_PATH_ROUTING_API_TESTNET: "https://legacy-name.test",
    });
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({ value: "https://new-name.test", warnings: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an explicit empty override of the new name wins over a lingering legacy value", async () => {
  const dir = tempDir();
  try {
    const { stdout, stderr, exitCode } = await runHarness(dir, "PATH_ROUTING_API_URLS", {
      PATH_ROUTING_API_TESTNET: "",
      NEXT_PUBLIC_PATH_ROUTING_API_TESTNET: "https://legacy-name.test",
    });
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    // "" falls through to the compiled default same as any other unset value would, but it must
    // NOT resurrect the legacy value or log a spurious deprecation warning - the operator
    // touched the new name on purpose.
    expect(JSON.parse(stdout)).toEqual({ value: "", warnings: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RPC_URLS reads the old name too, distinct from PATH_ROUTING_API_URLS's own pair", async () => {
  const dir = tempDir();
  try {
    const { stdout, stderr, exitCode } = await runHarness(dir, "RPC_URLS", {
      NEXT_PUBLIC_STELLAR_RPC_TESTNET: "https://legacy-rpc.test",
    });
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const parsed = JSON.parse(stdout);
    expect(parsed.value).toBe("https://legacy-rpc.test");
    expect(parsed.warnings).toEqual([
      "NEXT_PUBLIC_STELLAR_RPC_TESTNET is deprecated - rename it to STELLAR_RPC_TESTNET.",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MEDIATOR_PUBLIC_KEYS reads the old name too", async () => {
  const dir = tempDir();
  try {
    const { stdout, stderr, exitCode } = await runHarness(dir, "MEDIATOR_PUBLIC_KEYS", {
      NEXT_PUBLIC_MEDIATOR_PUBLIC_TESTNET: "GLEGACYKEY",
    });
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const parsed = JSON.parse(stdout);
    expect(parsed.value).toBe("GLEGACYKEY");
    expect(parsed.warnings).toEqual([
      "NEXT_PUBLIC_MEDIATOR_PUBLIC_TESTNET is deprecated - rename it to MEDIATOR_PUBLIC_TESTNET.",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
