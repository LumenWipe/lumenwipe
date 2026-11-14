import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEV_STORE_FILE, devFileKv, memoryKv, type KvRecords, type SessionKv } from "@/lib/kv";
import {
  DEV_FILE_STORE_FLAG,
  PlaygroundStoreUnavailableError,
  resolveSessionKv,
} from "@/lib/session-store";

// The file-backed session store is for local development only. It holds encrypted demo keys, so it
// is opt-in, never used by a deployment, private to the user on disk, and keeps no expired record.

const REDIS = { UPSTASH_REDIS_REST_URL: "https://redis.example", UPSTASH_REDIS_REST_TOKEN: "t" };

describe("which store a process uses", () => {
  const redisKv = memoryKv();
  const fileKv = memoryKv();
  const make = { redis: () => redisKv, file: () => fileKv };
  const resolve = (env: Record<string, string | undefined>) => resolveSessionKv(env, make);

  test("Redis whenever it is configured, with or without the flag", () => {
    expect(resolve({ ...REDIS, NODE_ENV: "production" })).toBe(redisKv);
    expect(resolve({ ...REDIS, NODE_ENV: "development", [DEV_FILE_STORE_FLAG]: "1" })).toBe(
      redisKv
    );
  });

  test("the file store only with the flag set to 1, outside a deployment", () => {
    expect(resolve({ NODE_ENV: "development", [DEV_FILE_STORE_FLAG]: "1" })).toBe(fileKv);
    expect(resolve({ NODE_ENV: "test", [DEV_FILE_STORE_FLAG]: "1" })).toBe(fileKv);
  });

  test("without Redis or the flag there is no store, even in development", () => {
    for (const flag of [undefined, "", "0", "true", "yes"]) {
      expect(() => resolve({ NODE_ENV: "development", [DEV_FILE_STORE_FLAG]: flag })).toThrow(
        PlaygroundStoreUnavailableError
      );
    }
  });

  test("a deployment without Redis fails closed, even with the flag set", () => {
    for (const env of [
      { NODE_ENV: "production", [DEV_FILE_STORE_FLAG]: "1" },
      { NODE_ENV: "development", VERCEL: "1", [DEV_FILE_STORE_FLAG]: "1" },
      { NODE_ENV: "production" },
    ]) {
      expect(() => resolve(env)).toThrow(PlaygroundStoreUnavailableError);
    }
  });
});

test("the default store file is never under the shared temp dir", () => {
  expect(DEV_STORE_FILE.startsWith(tmpdir())).toBe(false);
  expect(DEV_STORE_FILE.startsWith(join(process.cwd(), "node_modules", ".cache"))).toBe(true);
});

describe("the store on disk", () => {
  let root: string;
  let dir: string;
  let file: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lw-dev-store-"));
    dir = join(root, "store");
    file = join(dir, "dev-sessions.json");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const mode = (path: string): number => statSync(path).mode & 0o777;
  const onDisk = (): KvRecords => JSON.parse(readFileSync(file, "utf8")) as KvRecords;

  test("a new store's file is 0600 in a 0700 directory, after every write", async () => {
    const kv = devFileKv(file);
    await kv.set("a", 1, 60);
    expect(mode(dir)).toBe(0o700);
    expect(mode(file)).toBe(0o600);
    await kv.set("b", 2, 60);
    expect(mode(file)).toBe(0o600);
  });

  test("a looser file and directory left from before are made private on the next write", async () => {
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    writeFileSync(file, "{}", { mode: 0o644 });
    chmodSync(file, 0o644);
    await devFileKv(file).set("a", 1, 60);
    expect(mode(dir)).toBe(0o700);
    expect(mode(file)).toBe(0o600);
  });

  test("a store directory that is a symbolic link is refused, and nothing lands at its target", async () => {
    const target = join(root, "elsewhere");
    mkdirSync(target, { mode: 0o755 });
    chmodSync(target, 0o755);
    symlinkSync(target, dir, "dir");
    await expect(devFileKv(file).set("a", 1, 60)).rejects.toThrow(/symbolic link/);
    expect(readdirSync(target)).toEqual([]);
    expect(mode(target)).toBe(0o755);
  });

  test("a write leaves no temporary file behind", async () => {
    const kv = devFileKv(file);
    await kv.set("a", 1, 60);
    await kv.set("b", 2, 60);
    expect(readdirSync(dir)).toEqual(["dev-sessions.json"]);
  });

  test("every write prunes each expired record, not only the key it touches", async () => {
    let now = 1_000_000;
    const kv: SessionKv = devFileKv(file, () => now);
    await kv.set("playground:session:old", { secret: "enc" }, 60);
    await kv.acquire("playground:lock:old", "token", 1_000);
    await kv.indexAdd("playground:sessions", "old");
    now += 61_000;
    expect(Object.keys(onDisk())).toContain("playground:session:old");
    await kv.set("playground:session:new", { secret: "enc" }, 60);
    expect(Object.keys(onDisk()).sort()).toEqual(["playground:session:new", "playground:sessions"]);
  });
});
