import { beforeEach, expect, spyOn, test } from "bun:test";
import { Logger } from "@nestjs/common";
import { createDeadline } from "@/common/deadline";
import {
  parseRetryAfter,
  pathOnBase,
  resolveUpstreamUrl,
  rateLimitHits,
  resetUpstreamCounters,
  upstreamErrorCount,
  upstreamGetJson,
  UpstreamError,
} from "@/lib/stellar/upstream-client";

const BASE = "https://horizon.example";
const PATH = "/accounts/GSECRETADDRESS";

const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), { status: 200, ...init });

function script(...responses: Array<Response | Error>) {
  const calls: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    calls.push(String(input));
    const next = responses[Math.min(calls.length - 1, responses.length - 1)]!;
    if (next instanceof Error) throw next;
    return next.clone();
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

function sleeps() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number): Promise<void> => void waits.push(ms) };
}

beforeEach(() => resetUpstreamCounters());

test("a stalled upstream ends in a typed timeout at the deadline and is never retried past it", async () => {
  let calls = 0;
  const fetch = ((_url: string, init: RequestInit) => {
    calls++;
    return new Promise((_, reject) =>
      init.signal!.addEventListener("abort", () => reject(new Error("aborted")))
    );
  }) as unknown as typeof globalThis.fetch;

  const started = Date.now();
  const failure = await upstreamGetJson(BASE, PATH, {
    target: "horizon",
    fetch,
    deadline: createDeadline(150),
    policy: { perAttemptMs: 60, baseBackoffMs: 1 },
  }).catch((e: unknown) => e);

  expect(failure).toBeInstanceOf(UpstreamError);
  expect(failure).toMatchObject({ kind: "timeout" });
  expect(Date.now() - started).toBeLessThan(400);
  const callsAtFailure = calls;
  await new Promise((r) => setTimeout(r, 200));
  expect(calls).toBe(callsAtFailure);
});

test("an attempt never outlives what is left of the deadline", async () => {
  const seen: number[] = [];
  const fetch = ((_url: string, init: RequestInit) => {
    const startedAt = Date.now();
    return new Promise((_, reject) =>
      init.signal!.addEventListener("abort", () => {
        seen.push(Date.now() - startedAt);
        reject(new Error("aborted"));
      })
    );
  }) as unknown as typeof globalThis.fetch;

  await upstreamGetJson(BASE, PATH, {
    target: "horizon",
    fetch,
    deadline: createDeadline(80),
    policy: { perAttemptMs: 10_000 },
  }).catch(() => {});

  expect(seen).toHaveLength(1);
  expect(seen[0]!).toBeLessThan(500);
});

test("retries 429, 5xx and network faults, then returns the body", async () => {
  const { fetch, calls } = script(
    new Response("", { status: 429 }),
    new Response("", { status: 503 }),
    new TypeError("fetch failed"),
    json({ ok: true })
  );
  const { sleep } = sleeps();
  expect(
    await upstreamGetJson<{ ok: boolean }>(BASE, PATH, { target: "horizon", fetch, sleep })
  ).toEqual({
    ok: true,
  });
  expect(calls).toHaveLength(4);
  expect(rateLimitHits()).toBe(1);
});

test("backoff is jittered inside an exponential ceiling", async () => {
  const { fetch } = script(new Response("", { status: 503 }));
  const { waits, sleep } = sleeps();
  await upstreamGetJson(BASE, PATH, {
    target: "horizon",
    fetch,
    sleep,
    random: () => 0.5,
  }).catch(() => {});
  expect(waits).toEqual([200, 400, 800]);

  const low = sleeps();
  await upstreamGetJson(BASE, PATH, {
    target: "horizon",
    fetch,
    sleep: low.sleep,
    random: () => 0,
  }).catch(() => {});
  expect(low.waits).toEqual([0, 0, 0]);
});

test("a Retry-After in seconds is honored", async () => {
  const { fetch } = script(
    new Response("", { status: 429, headers: { "Retry-After": "2" } }),
    json({})
  );
  const { waits, sleep } = sleeps();
  await upstreamGetJson(BASE, PATH, { target: "horizon", fetch, sleep });
  expect(waits).toEqual([2000]);
});

test("a Retry-After HTTP-date is honored, relative to the clock", async () => {
  const now = Date.parse("2026-10-10T12:00:00Z");
  const { fetch } = script(
    new Response("", {
      status: 429,
      headers: { "Retry-After": new Date(now + 3000).toUTCString() },
    }),
    json({})
  );
  const { waits, sleep } = sleeps();
  await upstreamGetJson(BASE, PATH, { target: "horizon", fetch, sleep, now: () => now });
  expect(waits).toEqual([3000]);
});

test("hostile Retry-After values are capped or ignored", () => {
  const now = Date.parse("2026-10-10T12:00:00Z");
  const cap = 5000;
  expect(parseRetryAfter("600", now, cap)).toBe(cap);
  expect(parseRetryAfter("99999999999999999999", now, cap)).toBe(cap);
  expect(parseRetryAfter(new Date(now + 3_600_000).toUTCString(), now, cap)).toBe(cap);
  for (const hostile of ["-5", "0", "", "  ", "soon", "NaN", "Infinity", "1e9", "0x10"]) {
    const parsed = parseRetryAfter(hostile, now, cap);
    expect(parsed === null || parsed <= cap).toBe(true);
  }
  expect(parseRetryAfter(new Date(now - 1000).toUTCString(), now, cap)).toBeNull();
  expect(parseRetryAfter(null, now, cap)).toBeNull();
});

test("a hostile Retry-After falls back to the jittered backoff", async () => {
  const { fetch } = script(
    new Response("", { status: 429, headers: { "Retry-After": "-1" } }),
    json({})
  );
  const { waits, sleep } = sleeps();
  await upstreamGetJson(BASE, PATH, { target: "horizon", fetch, sleep, random: () => 0.5 });
  expect(waits).toEqual([200]);
});

test("does not sleep past the deadline", async () => {
  const { fetch, calls } = script(
    new Response("", { status: 429, headers: { "Retry-After": "5" } })
  );
  const { waits, sleep } = sleeps();
  const failure = await upstreamGetJson(BASE, PATH, {
    target: "horizon",
    fetch,
    sleep,
    deadline: createDeadline(1000),
  }).catch((e: unknown) => e);
  expect(failure).toMatchObject({ kind: "timeout" });
  expect(waits).toEqual([]);
  expect(calls).toHaveLength(1);
});

test.each([400, 401, 403, 410, 422])(
  "status %i is a bad_response with no retry and no status or URL in the message",
  async (status) => {
    const { fetch, calls } = script(new Response("body with GSECRETADDRESS", { status }));
    const failure = (await upstreamGetJson(BASE, PATH, { target: "horizon", fetch }).catch(
      (e: unknown) => e
    )) as UpstreamError;
    expect(failure).toBeInstanceOf(UpstreamError);
    expect(failure.kind).toBe("bad_response");
    expect(calls).toHaveLength(1);
    expect(failure.message).not.toMatch(new RegExp(`${status}|horizon\\.example|GSECRET|http`));
  }
);

test("sustained failures end in the matching kind with a plain message", async () => {
  const cases: Array<[Response | Error, string]> = [
    [new Response("", { status: 429 }), "rate_limited"],
    [new Response("", { status: 502 }), "unavailable"],
    [new TypeError("fetch failed: https://horizon.example"), "unavailable"],
  ];
  for (const [response, kind] of cases) {
    const { fetch, calls } = script(response);
    const failure = (await upstreamGetJson(BASE, PATH, {
      target: "horizon",
      fetch,
      sleep: async () => {},
    }).catch((e: unknown) => e)) as UpstreamError;
    expect(failure.kind).toBe(kind as UpstreamError["kind"]);
    expect(calls).toHaveLength(4);
    expect(failure.message).not.toMatch(/\d{3}|horizon\.example|https?:/);
  }
  expect(upstreamErrorCount()).toBe(3);
});

test("a 200 whose body is not JSON is a bad_response, not an empty result", async () => {
  const { fetch } = script(new Response("<html>oops</html>", { status: 200 }));
  await expect(upstreamGetJson(BASE, PATH, { target: "horizon", fetch })).rejects.toMatchObject({
    kind: "bad_response",
  });
});

test("404 is null only when asked, otherwise a bad_response", async () => {
  const { fetch } = script(new Response("", { status: 404 }));
  expect(
    await upstreamGetJson(BASE, PATH, { target: "horizon", fetch, notFoundIsNull: true })
  ).toBeNull();
  await expect(upstreamGetJson(BASE, PATH, { target: "horizon", fetch })).rejects.toMatchObject({
    kind: "bad_response",
  });
});

test("every timer the client creates is cleared on success, failure and throw", async () => {
  const created = new Set<ReturnType<typeof setTimeout>>();
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    const id = realSet(fn, ms);
    created.add(id);
    return id;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id?: ReturnType<typeof setTimeout>) => {
    if (id !== undefined) created.delete(id);
    realClear(id);
  }) as typeof clearTimeout;
  try {
    const sleep = async (): Promise<void> => {};
    await upstreamGetJson(BASE, PATH, { target: "h", fetch: script(json({})).fetch, sleep });
    await upstreamGetJson(BASE, PATH, {
      target: "h",
      fetch: script(new Response("", { status: 503 })).fetch,
      sleep,
    }).catch(() => {});
    await upstreamGetJson(BASE, PATH, {
      target: "h",
      fetch: script(new Error("boom")).fetch,
      sleep,
    }).catch(() => {});
    await upstreamGetJson(BASE, PATH, {
      target: "h",
      fetch: script(new Response("nope", { status: 200 })).fetch,
      sleep,
    }).catch(() => {});
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
  expect(created.size).toBe(0);
});

test("the failure log carries only the target label and the error kind", async () => {
  const warn = spyOn(Logger.prototype, "warn").mockImplementation(() => {});
  try {
    const { fetch } = script(new Response("body with GSECRETADDRESS", { status: 410 }));
    await upstreamGetJson(BASE, PATH, { target: "horizon", fetch }).catch(() => {});
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toEqual({
      message: "upstream read failed",
      target: "horizon",
      kind: "bad_response",
    });
  } finally {
    warn.mockRestore();
  }
});

test.each([
  "https://evil.example/x",
  "//evil.example/x",
  "/\\evil.example/x",
  "\\\\evil.example",
  "evil.example/x",
  "@evil.example/x",
  "/accounts/x y",
  "",
])("a path that tries to leave the base is refused: %p", (path) => {
  expect(() => resolveUpstreamUrl(BASE, path, "horizon")).toThrow(UpstreamError);
});

test.each([
  ["/accounts/G1%2F..%2F..%2Fx", "/accounts/G1%2F..%2F..%2Fx"],
  ["/accounts/a@evil.example", "/accounts/a@evil.example"],
  ["/accounts/x?next=https://evil.example", "/accounts/x"],
])(
  "a path with an encoded slash or userinfo trick stays on the base origin: %p",
  (path, pathname) => {
    const url = resolveUpstreamUrl("https://user:pw@horizon.example/v1/", path, "horizon");
    expect(url.origin).toBe("https://horizon.example");
    expect(url.pathname.startsWith("/v1/accounts/")).toBe(true);
    expect(url.pathname).toBe(`/v1${pathname}`);
  }
);

test("a base that is not a URL is unavailable, not fetched", async () => {
  const { fetch, calls } = script(json({}));
  await expect(upstreamGetJson("not a url", PATH, { target: "t", fetch })).rejects.toMatchObject({
    kind: "unavailable",
  });
  expect(calls).toHaveLength(0);
});

test("a refused path is never fetched", async () => {
  const { fetch, calls } = script(json({}));
  await expect(
    upstreamGetJson(BASE, "//evil.example/x", { target: "t", fetch })
  ).rejects.toMatchObject({ kind: "bad_response" });
  expect(calls).toHaveLength(0);
});

test("a next link is followed only on the base origin, relative to the base path", () => {
  const base = "https://host.example/horizon/v1";
  expect(pathOnBase("https://host.example/horizon/v1/offers?cursor=2", base, "h")).toBe(
    "/offers?cursor=2"
  );
  for (const hostile of [
    "https://host.example.evil.example/offers",
    "//evil.example/offers",
    "https://user@evil.example/offers",
    "https://evil.example\\@host.example/offers",
  ]) {
    expect(() => pathOnBase(hostile, base, "h")).toThrow(UpstreamError);
  }
});
