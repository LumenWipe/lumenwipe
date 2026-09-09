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

async function runHarness(
  dir: string,
  env: Record<string, string>
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const harnessPath = join(dir, "harness.ts");
  writeFileSync(
    harnessPath,
    [
      `import { PATH_ROUTING_API_URLS, deprecatedEnvWarnings } from "${networksPath}";`,
      `process.stdout.write(JSON.stringify({ url: PATH_ROUTING_API_URLS.testnet, warnings: deprecatedEnvWarnings }));`,
      "",
    ].join("\n")
  );
  const proc = Bun.spawn(["bun", "run", harnessPath], {
    cwd: dir,
    // Merge onto the real environment (for PATH etc.) rather than replacing it, but drop any
    // of these vars the *outer* test process might already have set, so only what this call
    // passes in is visible to the harness.
    env: {
      ...process.env,
      NEXT_PUBLIC_PATH_ROUTING_API_TESTNET: "",
      PATH_ROUTING_API_TESTNET: "",
      ...env,
      NODE_ENV: "test",
    },
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
    const { stdout, stderr, exitCode } = await runHarness(dir, {
      PATH_ROUTING_API_TESTNET: "https://new-name.test",
    });
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({ url: "https://new-name.test", warnings: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the old NEXT_PUBLIC_-prefixed name still works, with a deprecation warning naming it", async () => {
  const dir = tempDir();
  try {
    const { stdout, stderr, exitCode } = await runHarness(dir, {
      NEXT_PUBLIC_PATH_ROUTING_API_TESTNET: "https://legacy-name.test",
    });
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const parsed = JSON.parse(stdout);
    expect(parsed.url).toBe("https://legacy-name.test");
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
    const { stdout, stderr, exitCode } = await runHarness(dir, {
      PATH_ROUTING_API_TESTNET: "https://new-name.test",
      NEXT_PUBLIC_PATH_ROUTING_API_TESTNET: "https://legacy-name.test",
    });
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({ url: "https://new-name.test", warnings: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
