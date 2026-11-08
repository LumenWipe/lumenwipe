import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { rateLimitProxy } from "@/lib/api/rate-limit";
import { checkNamespacedRateLimit } from "@/lib/upstash-redis";

const LIMITER = "https://limiter.invalid";
const IP = "203.0.113.42";
const IP_HASH = createHash("sha256").update(IP).digest("hex").slice(0, 16);
const VARS = [
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "VERCEL_ENV",
] as const;

type Reply = () => Promise<Response>;

let saved: Record<string, string | undefined>;
let reply: Reply;
let fetchSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;

const counted =
  (count: unknown): Reply =>
  async () =>
    Response.json([{ result: count }, { result: 1 }]);

function configure(env: Partial<Record<(typeof VARS)[number], string>>): void {
  for (const name of VARS) delete process.env[name];
  Object.assign(process.env, env);
}

const UPSTASH = { UPSTASH_REDIS_REST_URL: LIMITER, UPSTASH_REDIS_REST_TOKEN: "test-token" };

/** The origin a fetch was sent to, or null for an input that is not a URL. */
function originOf(input: unknown): string | null {
  try {
    return new URL(input instanceof Request ? input.url : String(input)).origin;
  } catch {
    return null;
  }
}

function limiterCalls(): number {
  return (fetchSpy.mock.calls as unknown[][]).filter(([input]) => originOf(input) === LIMITER)
    .length;
}

function logged(): string {
  return [...errorSpy.mock.calls, ...warnSpy.mock.calls].flat().map(String).join("\n");
}

function request(network?: string): NextRequest {
  return new NextRequest(`https://www.lumenwipe.com/api/${network ?? "x"}/route`, {
    headers: { "x-real-ip": IP },
  });
}

beforeEach(() => {
  saved = Object.fromEntries(VARS.map((name) => [name, process.env[name]]));
  configure(UPSTASH);
  reply = counted(1);
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () =>
    reply()) as unknown as typeof globalThis.fetch);
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  fetchSpy.mockRestore();
  errorSpy.mockRestore();
  warnSpy.mockRestore();
  for (const name of VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe("checkNamespacedRateLimit", () => {
  test("a count within the limit is allowed, one past it is limited", async () => {
    reply = counted(5);
    expect(await checkNamespacedRateLimit("t", IP, 5)).toBe("allowed");
    reply = counted(6);
    expect(await checkNamespacedRateLimit("t", IP, 5)).toBe("limited");
    expect(limiterCalls()).toBe(2);
  });

  test("an unreachable counter is unavailable, after one attempt", async () => {
    reply = async () => {
      throw new TypeError(`fetch failed for ${IP} ${IP_HASH}`);
    };
    expect(await checkNamespacedRateLimit("t", IP, 5)).toBe("unavailable");
    expect(limiterCalls()).toBe(1);
  });

  test("a counter that hangs is unavailable once the timeout passes", async () => {
    reply = () => new Promise<Response>(() => {});
    const started = performance.now();
    expect(await checkNamespacedRateLimit("t", IP, 5, { timeoutMs: 20 })).toBe("unavailable");
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("a reply that is not a count is unavailable, not limited", async () => {
    reply = counted("OK");
    expect(await checkNamespacedRateLimit("t", IP, 5)).toBe("unavailable");
  });

  test.each([[undefined], ["development"]])(
    "no credentials with VERCEL_ENV=%s (local or CI) disables limiting, with no fetch",
    async (vercelEnv) => {
      configure(vercelEnv ? { VERCEL_ENV: vercelEnv } : {});
      expect(await checkNamespacedRateLimit("t", IP, 5)).toBe("disabled");
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  );

  test.each([["production"], ["preview"]])(
    "no credentials on a %s deployment is unavailable, never disabled",
    async (vercelEnv) => {
      configure({ VERCEL_ENV: vercelEnv });
      expect(await checkNamespacedRateLimit("t", IP, 5)).toBe("unavailable");
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  );

  test("production is told by VERCEL_ENV, not NODE_ENV", async () => {
    configure({});
    const nodeEnv = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = "production";
    try {
      expect(await checkNamespacedRateLimit("t", IP, 5)).toBe("disabled");
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = nodeEnv;
    }
  });

  test("the KV_REST_API_* fallback counts as configured", async () => {
    configure({
      KV_REST_API_URL: LIMITER,
      KV_REST_API_TOKEN: "test-token",
      VERCEL_ENV: "production",
    });
    expect(await checkNamespacedRateLimit("t", IP, 5)).toBe("allowed");
    expect(limiterCalls()).toBe(1);
  });

  test("no log line carries the IP, its hash or the error's message", async () => {
    reply = async () => {
      throw new TypeError(`fetch failed for ${IP} ${IP_HASH}`);
    };
    await checkNamespacedRateLimit("t", IP, 5);
    reply = () => new Promise<Response>(() => {});
    await checkNamespacedRateLimit("t", IP, 5, { timeoutMs: 5 });
    reply = counted("OK");
    await checkNamespacedRateLimit("t", IP, 5);
    configure({ VERCEL_ENV: "production" });
    await checkNamespacedRateLimit("t", IP, 5);
    configure({});
    await checkNamespacedRateLimit("t", IP, 5);

    const text = logged();
    expect(text).toContain("Rate limiter unavailable for t: error (TypeError)");
    expect(text).toContain("Rate limiter unavailable for t: timeout");
    expect(text).toContain("Rate limiter unavailable for t: bad_reply");
    expect(text).not.toContain(IP);
    expect(text).not.toContain(IP_HASH);
    expect(text).not.toContain("fetch failed");
  });
});

describe("rateLimitProxy", () => {
  test("over the limit is a 429", async () => {
    reply = counted(501);
    const res = await rateLimitProxy(request(), "t");
    expect(res?.status).toBe(429);
  });

  test("an unavailable limiter lets a default route through", async () => {
    reply = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await rateLimitProxy(request(), "t")).toBeNull();
  });

  test("an unavailable limiter refuses a fail-closed route with a retryable, uncached 503", async () => {
    reply = async () => {
      throw new TypeError("fetch failed");
    };
    const res = await rateLimitProxy(request(), "t", { whenUnavailable: "refuse" });
    expect(res?.status).toBe(503);
    expect(res?.headers.get("Retry-After")).toBe("30");
    expect(res?.headers.get("Cache-Control")).toBe("no-store");
    expect(await res?.json()).toEqual({
      error: { code: "service_unavailable", message: "The service is temporarily unavailable." },
    });
  });

  test("a disabled limiter lets both modes through", async () => {
    configure({});
    expect(await rateLimitProxy(request(), "t")).toBeNull();
    expect(await rateLimitProxy(request(), "t", { whenUnavailable: "refuse" })).toBeNull();
  });

  test("an unknown network is refused before the limiter is asked", async () => {
    const res = await rateLimitProxy(request(), "t", {
      params: Promise.resolve({ network: "devnet" }),
      whenUnavailable: "refuse",
    });
    expect(res?.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
