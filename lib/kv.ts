import { kv } from "@vercel/kv";
import { createHash } from "crypto";
import type { Network } from "@/config/networks";

// ─── Key layout ──────────────────────────────────────────────────────────────
// stats:{network}:count          → integer counter (accounts merged)
// stats:{network}:xlm            → integer counter (stroops recovered)
// stats:{network}:processed      → set of already-counted txHashes
// stats:{network}:recent         → list (max 100) of MergeRecord JSON strings
// stats:{network}:daily:{date}   → integer counter (merges per day, TTL ~13mo)
// stats:ratelimit:{ipHash}:{date} → per-IP daily request counter

const COUNT_KEY: Record<Network, string> = {
  testnet: "stats:testnet:count",
  mainnet: "stats:mainnet:count",
};

const XLM_KEY: Record<Network, string> = {
  testnet: "stats:testnet:xlm",
  mainnet: "stats:mainnet:xlm",
};

const PROCESSED_KEY = (n: Network) => `stats:${n}:processed`;
const RECENT_KEY = (n: Network) => `stats:${n}:recent`;
const DAILY_KEY = (n: Network, date: string) => `stats:${n}:daily:${date}`;
const RECENT_MAX = 100;
const RATE_KEY = (ipHash: string) =>
  `stats:ratelimit:${ipHash}:${new Date().toISOString().slice(0, 10)}`;

const RATE_LIMIT_PER_DAY = 20;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hashIp(ip: string): string {
  // One-way hash so no raw IP is stored in Redis
  return createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MergeRecord {
  txHash: string;
  xlmStroops: string;
  timestamp: string; // ISO 8601
  network: Network;
}

export interface DailyActivity {
  date: string; // YYYY-MM-DD
  count: number;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface StatsResult {
  testnet: number;
  mainnet: number;
  testnetXlmStroops: string;
  mainnetXlmStroops: string;
}

/**
 * Reads the global counters. Throws when KV is unreachable so callers can
 * report unavailability instead of serving misleading zero counts.
 */
export async function getStats(): Promise<StatsResult> {
  const [testnet, mainnet, testnetXlm, mainnetXlm] = await Promise.all([
    kv.get<number>(COUNT_KEY.testnet),
    kv.get<number>(COUNT_KEY.mainnet),
    kv.get<string>(XLM_KEY.testnet),
    kv.get<string>(XLM_KEY.mainnet),
  ]);
  return {
    testnet: testnet ?? 0,
    mainnet: mainnet ?? 0,
    testnetXlmStroops: testnetXlm ?? "0",
    mainnetXlmStroops: mainnetXlm ?? "0",
  };
}

/**
 * Increments the daily request counter for this IP and returns whether
 * the caller is within the allowed limit.
 * Fails open: if KV is unavailable the request is allowed through.
 */
export async function checkRateLimit(ip: string): Promise<boolean> {
  try {
    const key = RATE_KEY(hashIp(ip));
    // Increment and set TTL in one pipeline - both ops always run together
    const pipeline = kv.pipeline();
    pipeline.incr(key);
    pipeline.expire(key, 86_400); // 24 h TTL
    const [rawCount] = await pipeline.exec();
    const count = typeof rawCount === "number" ? rawCount : RATE_LIMIT_PER_DAY + 1;
    return count <= RATE_LIMIT_PER_DAY;
  } catch (err) {
    // Fail open rather than block legitimate users, but leave a trace
    console.error("Rate-limit check failed, allowing request:", err);
    return true;
  }
}

/**
 * Like checkRateLimit but with a caller-supplied namespace and daily limit,
 * so different features don't share one counter. Fails open like the original.
 */
export async function checkNamespacedRateLimit(
  namespace: string,
  ip: string,
  limitPerDay: number
): Promise<boolean> {
  try {
    const key = `${namespace}:ratelimit:${hashIp(ip)}:${new Date().toISOString().slice(0, 10)}`;
    const pipeline = kv.pipeline();
    pipeline.incr(key);
    pipeline.expire(key, 86_400);
    const [rawCount] = await pipeline.exec();
    const count = typeof rawCount === "number" ? rawCount : limitPerDay + 1;
    return count <= limitPerDay;
  } catch (err) {
    console.error(`Rate-limit check (${namespace}) failed, allowing request:`, err);
    return true;
  }
}

// Lua script: atomically check deduplication, increment account counter, and add XLM stroops.
// KEYS[1] = processed set, KEYS[2] = count key, KEYS[3] = xlm key
// ARGV[1] = txHash, ARGV[2] = xlmStroops
// Returns 1 when the txHash is new (counters updated), 0 when duplicate.
const RECORD_SCRIPT = `
  if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1 then
    return 0
  end
  redis.call('SADD', KEYS[1], ARGV[1])
  redis.call('INCR', KEYS[2])
  redis.call('INCRBY', KEYS[3], ARGV[2])
  return 1
`;

/**
 * Atomically records a merge for the given network.
 * Returns true when the txHash was new, false when it was a duplicate.
 * Throws when KV is unreachable so the caller can report the failure.
 */
export async function recordMerge(
  network: Network,
  txHash: string,
  xlmStroops: string
): Promise<boolean> {
  const result = await kv.eval(
    RECORD_SCRIPT,
    [PROCESSED_KEY(network), COUNT_KEY[network], XLM_KEY[network]],
    [txHash, xlmStroops]
  );
  const isNew = result === 1;
  if (isNew) {
    const timestamp = new Date().toISOString();
    pushRecentMerge(network, txHash, xlmStroops, timestamp).catch((err) =>
      console.error(`Failed to push recent merge for tx ${txHash}:`, err)
    );
  }
  return isNew;
}

async function pushRecentMerge(
  network: Network,
  txHash: string,
  xlmStroops: string,
  timestamp: string
): Promise<void> {
  const record: MergeRecord = { txHash, xlmStroops, timestamp, network };
  const date = timestamp.slice(0, 10);
  const pipeline = kv.pipeline();
  pipeline.lpush(RECENT_KEY(network), JSON.stringify(record));
  pipeline.ltrim(RECENT_KEY(network), 0, RECENT_MAX - 1);
  pipeline.incr(DAILY_KEY(network, date));
  pipeline.expire(DAILY_KEY(network, date), 400 * 86_400);
  await pipeline.exec();
}

export async function getRecentMerges(network: Network, limit = 20): Promise<MergeRecord[]> {
  const raw = await kv.lrange<string>(RECENT_KEY(network), 0, limit - 1);
  return raw
    .map((item) => {
      try {
        return JSON.parse(item) as MergeRecord;
      } catch {
        return null;
      }
    })
    .filter((item): item is MergeRecord => item !== null);
}

export async function getDailyActivity(network: Network, days = 365): Promise<DailyActivity[]> {
  const dates: string[] = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  const pipeline = kv.pipeline();
  for (const date of dates) {
    pipeline.get(DAILY_KEY(network, date));
  }
  const results = await pipeline.exec();
  return dates.map((date, i) => ({
    date,
    count: typeof results[i] === "number" ? (results[i] as number) : 0,
  }));
}
