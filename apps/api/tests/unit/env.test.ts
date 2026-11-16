import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parse } from "dotenv";

const originalCwd = process.cwd();

// `@/env` loads `.env.local` and `.env` from the cwd as it is imported. Imported from an empty
// directory, it reads no developer's env file into this process, whose environment the #88 child
// below inherits and every later test file in the run shares.
const { loadEnvFiles } = await (async () => {
  const empty = mkdtempSync(join(tmpdir(), "lumenwipe-env-import-"));
  try {
    process.chdir(empty);
    return await import("@/env");
  } finally {
    process.chdir(originalCwd);
    rmSync(empty, { recursive: true, force: true });
  }
})();
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

const SRC = join(import.meta.dir, "..", "..", "src");

test("main.ts imports env.ts before anything else (issue #88)", () => {
  const firstImport = readFileSync(join(SRC, "main.ts"), "utf8").match(/^import .+$/m)?.[0];
  expect(firstImport).toBe('import "./env";');
});

/** Imports env.ts then config/networks.ts, as main.ts does, in a child whose cwd holds only a
 *  .env.local with the legacy name, and returns what networks.ts read. */
async function importOrderHarness(
  parentEnv: Record<string, string | undefined>
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const dir = tempDirWithEnvFiles({
    ".env.local": "NEXT_PUBLIC_PATH_ROUTING_API_TESTNET=https://example-routing.test\n",
  });
  const harnessPath = join(dir, "harness.ts");
  writeFileSync(
    harnessPath,
    [
      `import "${join(SRC, "env.ts")}";`,
      `import { PATH_ROUTING_API_URLS } from "${join(SRC, "config", "networks.ts")}";`,
      "process.stdout.write(PATH_ROUTING_API_URLS.testnet);",
      "",
    ].join("\n")
  );

  // Rule out the parent's value under either name, so the temp .env.local is the only source of
  // truth: config/networks.ts takes the new name whenever it is present, even empty.
  const env = { ...parentEnv };
  delete env.PATH_ROUTING_API_TESTNET;
  delete env.NEXT_PUBLIC_PATH_ROUTING_API_TESTNET;
  // Bun itself auto-loads .env.local, which would mask the bug this test targets
  // (config/networks.ts's own import-time read, independent of any runtime's
  // built-in env loading). NODE_ENV=test makes Bun skip that auto-load, isolating
  // the assertion to env.ts's own dotenv bootstrap - same as the actual bug, which
  // surfaces under plain Node (`node dist/main.js` / nest's spawned dev process).
  env.NODE_ENV = "test";

  const proc = Bun.spawn(["bun", "run", harnessPath], {
    cwd: dir,
    env,
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

test("main.ts's import order lets config/networks.ts see a fresh .env.local with no shell var (issue #88)", async () => {
  expect(await importOrderHarness(process.env)).toEqual({
    stdout: "https://example-routing.test",
    stderr: "",
    exitCode: 0,
  });
});

test("the import order check holds when the runner already carries a .env.local made from .env.example", async () => {
  // What `cp .env.example .env.local` (CONTRIBUTING's setup) puts in an environment, including
  // PATH_ROUTING_API_TESTNET set to empty.
  const contributorEnv = parse(readFileSync(join(import.meta.dir, "..", "..", ".env.example")));
  expect(contributorEnv).toHaveProperty("PATH_ROUTING_API_TESTNET");
  expect(await importOrderHarness({ ...process.env, ...contributorEnv })).toEqual({
    stdout: "https://example-routing.test",
    stderr: "",
    exitCode: 0,
  });
});
