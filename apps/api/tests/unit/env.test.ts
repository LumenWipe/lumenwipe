import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadEnvFiles } from "@/env";

const originalCwd = process.cwd();
const cleanupKeys: string[] = [];
const cleanupDirs: string[] = [];

afterEach(() => {
  process.chdir(originalCwd);
  for (const key of cleanupKeys.splice(0)) delete process.env[key];
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDirWithEnvFiles(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "lumenwipe-env-"));
  cleanupDirs.push(dir);
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), contents);
  }
  return dir;
}

test("loadEnvFiles applies a .env.local-only value with no other default", () => {
  const key = "LUMENWIPE_TEST_PATH_ROUTING";
  cleanupKeys.push(key);
  delete process.env[key];
  const dir = tempDirWithEnvFiles({ ".env.local": `${key}=https://example-routing.test\n` });

  process.chdir(dir);
  loadEnvFiles();

  expect(process.env[key]).toBe("https://example-routing.test");
});

test("loadEnvFiles lets .env.local win over .env for the same key", () => {
  const key = "LUMENWIPE_TEST_PRECEDENCE";
  cleanupKeys.push(key);
  delete process.env[key];
  const dir = tempDirWithEnvFiles({
    ".env.local": `${key}=from-local\n`,
    ".env": `${key}=from-dotenv\n`,
  });

  process.chdir(dir);
  loadEnvFiles();

  expect(process.env[key]).toBe("from-local");
});

test("loadEnvFiles never overrides a real shell/OS environment variable", () => {
  const key = "LUMENWIPE_TEST_SHELL_WINS";
  cleanupKeys.push(key);
  process.env[key] = "from-shell";
  const dir = tempDirWithEnvFiles({ ".env.local": `${key}=from-local\n` });

  process.chdir(dir);
  loadEnvFiles();

  expect(process.env[key]).toBe("from-shell");
});

test("main.ts's import order lets config/networks.ts see a fresh .env.local with no shell var (issue #88)", async () => {
  const dir = tempDirWithEnvFiles({
    ".env.local": "NEXT_PUBLIC_PATH_ROUTING_API_TESTNET=https://example-routing.test\n",
  });
  const envPath = join(import.meta.dir, "..", "..", "src", "env.ts");
  const networksPath = join(import.meta.dir, "..", "..", "src", "config", "networks.ts");
  const harnessPath = join(dir, "harness.ts");
  writeFileSync(
    harnessPath,
    [
      `import "${envPath}";`,
      `import { PATH_ROUTING_API_URLS } from "${networksPath}";`,
      "process.stdout.write(PATH_ROUTING_API_URLS.testnet);",
      "",
    ].join("\n")
  );

  // Rule out a real shell export so the temp .env.local is the only source of truth.
  const envWithoutShellOverride = { ...process.env };
  delete envWithoutShellOverride.NEXT_PUBLIC_PATH_ROUTING_API_TESTNET;
  // Bun itself auto-loads .env.local, which would mask the bug this test targets
  // (config/networks.ts's own import-time read, independent of any runtime's
  // built-in env loading). NODE_ENV=test makes Bun skip that auto-load, isolating
  // the assertion to env.ts's own dotenv bootstrap - same as the actual bug, which
  // surfaces under plain Node (`node dist/main.js` / nest's spawned dev process).
  envWithoutShellOverride.NODE_ENV = "test";

  const proc = Bun.spawn(["bun", "run", harnessPath], {
    cwd: dir,
    env: envWithoutShellOverride,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  expect(stdout).toBe("https://example-routing.test");
});
