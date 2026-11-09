import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "install-release-binary.sh");
const TOOL = "#!/bin/sh\necho pinned tool\n";

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

// Two real archives: the binary at the top level, and the binary under a directory (as lychee ships it).
const fixtures = mkdtempSync(join(tmpdir(), "release-binary-fixtures-"));
mkdirSync(join(fixtures, "src", "pkg"), { recursive: true });
writeFileSync(join(fixtures, "src", "tool"), TOOL);
writeFileSync(join(fixtures, "src", "pkg", "tool"), TOOL);
for (const [name, member] of [
  ["flat.tar.gz", "tool"],
  ["nested.tar.gz", "pkg/tool"],
]) {
  const tar = Bun.spawnSync([
    "tar",
    "-czf",
    join(fixtures, name),
    "-C",
    join(fixtures, "src"),
    member,
  ]);
  if (tar.exitCode !== 0) throw new Error(`could not build ${name}`);
}
const FLAT = readFileSync(join(fixtures, "flat.tar.gz"));
const NESTED = readFileSync(join(fixtures, "nested.tar.gz"));
const FLAT_SHA = sha256(FLAT);
const NESTED_SHA = sha256(NESTED);

let failuresLeft = 0;
let requests = 0;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    requests += 1;
    if (failuresLeft-- > 0) {
      return new Response("unavailable", { status: 504 });
    }
    return new Response(new URL(req.url).pathname === "/nested.tar.gz" ? NESTED : FLAT);
  },
});
const BASE = `http://127.0.0.1:${server.port}`;

let dir = "";
let work = "";
let archive = "";
beforeEach(() => {
  requests = 0;
  failuresLeft = 0;
  dir = mkdtempSync(join(tmpdir(), "release-binary-test-"));
  work = join(dir, "work");
  mkdirSync(work);
  archive = join(dir, "cache", "tool-1.0.0.tar.gz");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
afterAll(() => {
  server.stop(true);
  rmSync(fixtures, { recursive: true, force: true });
});

async function install(args: string[]) {
  const proc = Bun.spawn(["bash", SCRIPT, ...args], {
    cwd: work,
    env: { ...process.env, DOWNLOAD_RETRY_MAX_TIME: "10" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, output: stdout + stderr };
}

function cacheArchive(bytes: Uint8Array) {
  mkdirSync(join(dir, "cache"));
  writeFileSync(archive, bytes);
}

describe("install-release-binary.sh", () => {
  test("on a cache miss, downloads, checks and extracts, keeping the archive for the cache save", async () => {
    const { code } = await install([archive, `${BASE}/flat.tar.gz`, FLAT_SHA, "tool"]);
    expect(code).toBe(0);
    expect(requests).toBe(1);
    expect(readFileSync(join(work, "tool"), "utf8")).toBe(TOOL);
    expect(sha256(readFileSync(archive))).toBe(FLAT_SHA);
  });

  test("on a cache hit, checks and extracts without a single request", async () => {
    cacheArchive(FLAT);
    const { code, output } = await install([archive, `${BASE}/flat.tar.gz`, FLAT_SHA, "tool"]);
    expect(code).toBe(0);
    expect(requests).toBe(0);
    expect(output).toContain("Using the cached tool-1.0.0.tar.gz");
    expect(readFileSync(join(work, "tool"), "utf8")).toBe(TOOL);
  });

  test("fails closed on a tampered cached archive: no download over it and no binary", async () => {
    const tampered = new Uint8Array(FLAT);
    tampered[tampered.length - 1] ^= 0xff;
    cacheArchive(tampered);
    const { code, output } = await install([archive, `${BASE}/flat.tar.gz`, FLAT_SHA, "tool"]);
    expect(code).toBe(1);
    expect(output).toContain("does not match the pinned SHA-256");
    expect(requests).toBe(0);
    expect(readdirSync(work)).toEqual([]);
  });

  test("on a cache miss, a download that does not match the pin fails as before", async () => {
    const { code, output } = await install([archive, `${BASE}/flat.tar.gz`, NESTED_SHA, "tool"]);
    expect(code).toBe(1);
    expect(requests).toBe(1);
    expect(output).not.toContain("cached");
    expect(readdirSync(work)).toEqual([]);
  });

  test("on a cache miss, retries a 5xx from the release host and then installs", async () => {
    failuresLeft = 2;
    const { code } = await install([archive, `${BASE}/flat.tar.gz`, FLAT_SHA, "tool"]);
    expect(code).toBe(0);
    expect(requests).toBe(3);
    expect(readFileSync(join(work, "tool"), "utf8")).toBe(TOOL);
  });

  test("strips leading directories from the member", async () => {
    const { code } = await install([archive, `${BASE}/nested.tar.gz`, NESTED_SHA, "pkg/tool", "1"]);
    expect(code).toBe(0);
    expect(readdirSync(work)).toEqual(["tool"]);
  });

  test.each([
    ["an uppercase sha256", [FLAT_SHA.toUpperCase(), "tool"]],
    ["a short sha256", [FLAT_SHA.slice(1), "tool"]],
    ["an absolute member", [FLAT_SHA, "/tool"]],
    ["a member that climbs out", [FLAT_SHA, "../tool"]],
    ["an empty member", [FLAT_SHA, ""]],
    ["a non-numeric strip", [FLAT_SHA, "tool", "x"]],
  ])("rejects %s before any request", async (_label, rest) => {
    const { code } = await install([archive, `${BASE}/flat.tar.gz`, ...rest]);
    expect(code).toBe(2);
    expect(requests).toBe(0);
    expect(readdirSync(work)).toEqual([]);
  });

  test("rejects a wrong argument count", async () => {
    const { code, output } = await install([archive, `${BASE}/flat.tar.gz`, FLAT_SHA]);
    expect(code).toBe(2);
    expect(output).toContain("usage:");
  });

  test("a cached archive is used even when the release host is down", async () => {
    cacheArchive(FLAT);
    failuresLeft = Infinity;
    const { code } = await install([archive, `${BASE}/flat.tar.gz`, FLAT_SHA, "tool"]);
    expect(code).toBe(0);
    expect(requests).toBe(0);
    expect(existsSync(join(work, "tool"))).toBe(true);
  });
});
