import "server-only";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  // Every write drops each expired entry, not only the key it touched, so a store nobody reads
  // back does not keep old sessions' encrypted keys around.
  const commit = (records: KvRecords): void => {
    const at = now();
    for (const [key, entry] of Object.entries(records)) {
      if (entry.expiresAt <= at) delete records[key];
    }
    io.write(records);
  };
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
      commit(records);
    },
    async acquire(lockKey, token, ttlMs) {
      const records = io.read();
      if (live(records, lockKey)) return false;
      put(records, lockKey, token, ttlMs);
      commit(records);
      return true;
    },
    async setIfLockHeld(lockKey, token, key, value, ttlSeconds) {
      const records = io.read();
      if (live(records, lockKey)?.value !== token) return false;
      put(records, key, value, ttlSeconds * 1000);
      commit(records);
      return true;
    },
    async delIfLockHeld(lockKey, token, key) {
      const records = io.read();
      if (live(records, lockKey)?.value !== token) return false;
      delete records[key];
      commit(records);
      return true;
    },
    async releaseIfHeld(lockKey, token) {
      const records = io.read();
      if (live(records, lockKey)?.value !== token) return;
      delete records[lockKey];
      commit(records);
    },
    async indexAdd(indexKey, member) {
      const records = io.read();
      const members = setMembers(live(records, indexKey));
      if (!members.includes(member)) members.push(member);
      records[indexKey] = { value: members, expiresAt: NEVER };
      commit(records);
    },
    async indexRemove(indexKey, member) {
      const records = io.read();
      const members = setMembers(live(records, indexKey));
      records[indexKey] = { value: members.filter((m) => m !== member), expiresAt: NEVER };
      commit(records);
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

// Inside the app's git-ignored node_modules cache, never the shared temp dir, where another local
// user could predict the path and pre-create or read the file.
export const DEV_STORE_FILE = join(
  process.cwd(),
  "node_modules",
  ".cache",
  "lumenwipe-playground",
  "dev-sessions.json"
);

/**
 * The file-backed store for local development, used only when PLAYGROUND_DEV_FILE_STORE=1 outside
 * a deployment (lib/session-store.ts `resolveSessionKv`). Its directory is private to the user
 * (0700) and every write lands in a new 0600 file renamed over the old one, so the records (which
 * hold encrypted demo keys) are never readable by anyone else, even when an older file or
 * directory was created with looser permissions.
 *
 * A file, not an in-process Map: Next.js dev compiles each API route as its own module graph, so a
 * module-level Map is not shared between the route that creates a session and the one that uses
 * it. Locks are atomic within the single dev server process, not across several processes.
 */
export function devFileKv(file: string = DEV_STORE_FILE, now: () => number = Date.now): SessionKv {
  const dir = dirname(file);
  return createRecordKv(
    {
      read() {
        try {
          if (!existsSync(file)) return {};
          return JSON.parse(readFileSync(file, "utf8")) as KvRecords;
        } catch {
          return {};
        }
      },
      write(records) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        if (lstatSync(dir).isSymbolicLink()) {
          throw new Error("The playground's dev session store directory is a symbolic link");
        }
        chmodSync(dir, 0o700);
        // A name no one can guess, created exclusively: an existing file at that path fails the
        // write instead of being written through.
        const temp = join(dir, `.dev-sessions-${randomBytes(16).toString("hex")}.tmp`);
        try {
          writeFileSync(temp, JSON.stringify(records), {
            encoding: "utf8",
            mode: 0o600,
            flag: "wx",
          });
          renameSync(temp, file);
        } catch (err) {
          rmSync(temp, { force: true });
          throw err;
        }
      },
    },
    now
  );
}
