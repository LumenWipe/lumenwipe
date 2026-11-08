import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "download.sh");
const BODY = "release tarball bytes";

let failuresLeft = 0;
let failStatus = 404;
let requests = 0;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch() {
    requests += 1;
    if (failuresLeft-- > 0) {
      return new Response("unavailable", { status: failStatus });
    }
    return new Response(BODY);
  },
});
const ASSET_URL = `http://127.0.0.1:${server.port}/asset.tar.gz`;

let dir = "";
beforeEach(() => {
  requests = 0;
  failuresLeft = 0;
  dir = mkdtempSync(join(tmpdir(), "download-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
afterAll(() => {
  server.stop(true);
});

async function download(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(["bash", SCRIPT, ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  return { code, stderr };
}

describe("download.sh", () => {
  test("retries an error that plain --retry would not, and writes the file on success", async () => {
    failuresLeft = 2;
    failStatus = 404;
    const out = join(dir, "asset.tar.gz");
    const { code } = await download([ASSET_URL, out]);
    expect(code).toBe(0);
    expect(requests).toBe(3);
    expect(readFileSync(out, "utf8")).toBe(BODY);
    expect(readdirSync(dir)).toEqual(["asset.tar.gz"]);
  });

  test("fails within the retry window and leaves no file behind", async () => {
    failuresLeft = Infinity;
    failStatus = 500;
    const out = join(dir, "asset.tar.gz");
    const { code } = await download([ASSET_URL, out], { DOWNLOAD_RETRY_MAX_TIME: "2" });
    expect(code).not.toBe(0);
    expect(requests).toBeGreaterThan(1);
    expect(existsSync(out)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  test.each(["0", "121", "abc", "1.5", "-3"])(
    "rejects DOWNLOAD_RETRY_MAX_TIME=%p before any request",
    async (value) => {
      const out = join(dir, "asset.tar.gz");
      const { code, stderr } = await download([ASSET_URL, out], { DOWNLOAD_RETRY_MAX_TIME: value });
      expect(code).toBe(2);
      expect(stderr).toContain("must be a whole number from 1 to 120");
      expect(requests).toBe(0);
      expect(readdirSync(dir)).toEqual([]);
    }
  );

  test("rejects a wrong argument count", async () => {
    const { code, stderr } = await download([ASSET_URL]);
    expect(code).toBe(2);
    expect(stderr).toContain("usage:");
  });
});
