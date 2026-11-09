import "server-only";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { redis } from "./upstash-redis";

/** The key-value operations the session store needs, small enough to back with Redis or a record. */
export interface SessionKv {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  /** Sets `lockKey` to `token` only when no live lock exists. */
  acquire(lockKey: string, token: string, ttlMs: number): Promise<boolean>;
  /** Writes `key` only while `lockKey` still holds `token`, checked atomically with the write. */
  setIfLockHeld(
    lockKey: string,
    token: string,
    key: string,
    value: unknown,
    ttlSeconds: number
  ): Promise<boolean>;
  /** Deletes `key` only while `lockKey` still holds `token`, checked atomically with the delete. */
  delIfLockHeld(lockKey: string, token: string, key: string): Promise<boolean>;
  releaseIfHeld(lockKey: string, token: string): Promise<void>;
  /** Adds `member` to the set at `indexKey`, which never expires. */
  indexAdd(indexKey: string, member: string): Promise<void>;
  indexRemove(indexKey: string, member: string): Promise<void>;
  indexMembers(indexKey: string): Promise<string[]>;
}

const SET_IF_LOCK_HELD = `if redis.call("GET", KEYS[1]) == ARGV[1] then
  redis.call("SET", KEYS[2], ARGV[2], "EX", ARGV[3])
  return 1
end
return 0`;

const DEL_IF_LOCK_HELD = `if redis.call("GET", KEYS[1]) == ARGV[1] then
  redis.call("DEL", KEYS[2])
  return 1
end
return 0`;

const RELEASE_IF_HELD = `if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0`;

export function upstashKv(): SessionKv {
  return {
    get: (key) => redis().get(key),
    async set(key, value, ttlSeconds) {
      await redis().set(key, value, { ex: ttlSeconds });
    },
    async acquire(lockKey, token, ttlMs) {
      return (await redis().set(lockKey, token, { nx: true, px: ttlMs })) !== null;
    },
    async setIfLockHeld(lockKey, token, key, value, ttlSeconds) {
      const written = await redis().eval<string[], number>(
        SET_IF_LOCK_HELD,
        [lockKey, key],
        [token, JSON.stringify(value), String(ttlSeconds)]
      );
      return written === 1;
    },
    async delIfLockHeld(lockKey, token, key) {
      const deleted = await redis().eval<string[], number>(
        DEL_IF_LOCK_HELD,
        [lockKey, key],
        [token]
      );
      return deleted === 1;
    },
    async releaseIfHeld(lockKey, token) {
      await redis().eval<string[], number>(RELEASE_IF_HELD, [lockKey], [token]);
    },
    async indexAdd(indexKey, member) {
      await redis().sadd(indexKey, member);
    },
    async indexRemove(indexKey, member) {
      await redis().srem(indexKey, member);
    },
    indexMembers: (indexKey) => redis().smembers(indexKey),
  };
}

type RecordEntry = { value: unknown; expiresAt: number };

/** An index entry's expiry: finite, so it survives the dev file store's JSON round trip. */
const NEVER = Number.MAX_SAFE_INTEGER;
export type KvRecords = Record<string, RecordEntry>;

export interface RecordIo {
  read(): KvRecords;
  write(records: KvRecords): void;
}

/**
 * A SessionKv over a plain record. Each operation reads, mutates and writes synchronously with no
 * await in between, so it is atomic against every other request in the same process.
 */
export function createRecordKv(io: RecordIo, now: () => number = Date.now): SessionKv {
  const live = (records: KvRecords, key: string): RecordEntry | undefined => {
    const entry = records[key];
    if (!entry) return undefined;
    if (entry.expiresAt <= now()) {
      delete records[key];
      return undefined;
    }
    return entry;
  };
  // Copies on the way in and out, so a caller mutating a value it read cannot change the store,
  // matching what a networked store gives.
  const put = (records: KvRecords, key: string, value: unknown, ttlMs: number): void => {
    records[key] = { value: structuredClone(value), expiresAt: now() + ttlMs };
  };

  return {
    async get(key) {
      return structuredClone(live(io.read(), key)?.value ?? null);
    },
    async set(key, value, ttlSeconds) {
      const records = io.read();
      put(records, key, value, ttlSeconds * 1000);
      io.write(records);
    },
    async acquire(lockKey, token, ttlMs) {
      const records = io.read();
      if (live(records, lockKey)) return false;
      put(records, lockKey, token, ttlMs);
      io.write(records);
      return true;
    },
    async setIfLockHeld(lockKey, token, key, value, ttlSeconds) {
      const records = io.read();
      if (live(records, lockKey)?.value !== token) return false;
      put(records, key, value, ttlSeconds * 1000);
      io.write(records);
      return true;
    },
    async delIfLockHeld(lockKey, token, key) {
      const records = io.read();
      if (live(records, lockKey)?.value !== token) return false;
      delete records[key];
      io.write(records);
      return true;
    },
    async releaseIfHeld(lockKey, token) {
      const records = io.read();
      if (live(records, lockKey)?.value !== token) return;
      delete records[lockKey];
      io.write(records);
    },
    async indexAdd(indexKey, member) {
      const records = io.read();
      const members = setMembers(live(records, indexKey));
      if (!members.includes(member)) members.push(member);
      records[indexKey] = { value: members, expiresAt: NEVER };
      io.write(records);
    },
    async indexRemove(indexKey, member) {
      const records = io.read();
      const members = setMembers(live(records, indexKey));
      records[indexKey] = { value: members.filter((m) => m !== member), expiresAt: NEVER };
      io.write(records);
    },
    async indexMembers(indexKey) {
      return setMembers(live(io.read(), indexKey));
    },
  };
}

function setMembers(entry: RecordEntry | undefined): string[] {
  const value = entry?.value;
  return Array.isArray(value) ? value.filter((m): m is string => typeof m === "string") : [];
}

export function memoryKv(now: () => number = Date.now): SessionKv {
  let records: KvRecords = {};
  return createRecordKv(
    {
      read: () => records,
      write: (next) => {
        records = next;
      },
    },
    now
  );
}

// Inside the app's git-ignored node_modules cache, not the shared temp dir, where another local
// user could predict the path and pre-create or read the file.
export const DEV_STORE_FILE = join(
  process.cwd(),
  "node_modules",
  ".cache",
  "lumenwipe-playground",
  "dev-sessions.json"
);

// A file, not an in-process Map: Next.js dev compiles each API route as its own module graph, so a
// module-level Map is not shared between the route that creates a session and the one that uses it.
// Locks are atomic within the single dev server process, not across several processes.
export function devFileKv(): SessionKv {
  return createRecordKv({
    read() {
      try {
        if (!existsSync(DEV_STORE_FILE)) return {};
        return JSON.parse(readFileSync(DEV_STORE_FILE, "utf8")) as KvRecords;
      } catch {
        return {};
      }
    },
    write(records) {
      mkdirSync(dirname(DEV_STORE_FILE), { recursive: true, mode: 0o700 });
      writeFileSync(DEV_STORE_FILE, JSON.stringify(records), { encoding: "utf8", mode: 0o600 });
    },
  });
}
