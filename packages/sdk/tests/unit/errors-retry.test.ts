import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  LumenWipeAbortError,
  LumenWipeApiError,
  LumenWipeClient,
  LumenWipeTimeoutError,
  isApiErrorCode,
  type FetchLike,
  type LumenWipeClientOptions,
} from "../../src/index";

const envelope = {
  error: {
    code: "destination_not_acknowledged",
    message: "The destination needs a memo.",
    details: { memoType: "id" },
  },
};

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function sequence(...responses: Array<Response | Error>): {
  fetch: FetchLike;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const queue = [...responses];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (next === undefined) throw new Error("fetch called more times than scripted");
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  return { fetch, calls };
}

function hangingFetch(): FetchLike {
  return (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("The operation was aborted.", "AbortError"))
      );
    });
}

function make(fetch: FetchLike, extra: Partial<LumenWipeClientOptions> = {}): LumenWipeClient {
  return new LumenWipeClient({
    baseUrl: "https://x",
    apiKey: "k",
    network: "testnet",
    fetch,
    ...extra,
  });
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error("expected the call to reject");
}

test("LumenWipeApiError exposes the envelope fields and headers", async () => {
  const { fetch } = sequence(
    json(422, envelope, { "Retry-After": "2", "X-Request-Id": "req_123" })
  );
  const error = (await caught(make(fetch).getAccount("GABC"))) as LumenWipeApiError;

  expect(error).toBeInstanceOf(LumenWipeApiError);
  expect(error.status).toBe(422);
  expect(error.code).toBe("destination_not_acknowledged");
  expect(error.details).toEqual({ memoType: "id" });
  expect(error.retryAfterMs).toBe(2000);
  expect(error.requestId).toBe("req_123");
  expect(error.message).toBe(
    "LumenWipe API error 422 destination_not_acknowledged: The destination needs a memo."
  );
});

test("Retry-After is read as an HTTP date too, and is undefined when missing", () => {
  const at = new Date(Date.now() + 5000).toUTCString();
  const dated = new LumenWipeApiError(503, envelope, new Headers({ "Retry-After": at }));
  expect(dated.retryAfterMs).toBeGreaterThan(0);
  expect(dated.retryAfterMs).toBeLessThanOrEqual(5000);

  const missing = new LumenWipeApiError(422, envelope, new Headers());
  expect(missing.retryAfterMs).toBeUndefined();
  expect(missing.requestId).toBeUndefined();
});

test("a non-JSON upstream body becomes code upstream_error", async () => {
  const { fetch } = sequence(new Response("<html>502 Bad Gateway</html>", { status: 502 }));
  const error = (await caught(make(fetch).getAccount("GABC"))) as LumenWipeApiError;

  expect(error.status).toBe(502);
  expect(error.code).toBe("upstream_error");
  expect(error.details).toBeUndefined();
  expect(error.body).toBe("<html>502 Bad Gateway</html>");
  expect(error.message).toBe("LumenWipe API error 502");
});

test("isApiErrorCode narrows only a matching LumenWipeApiError", async () => {
  const { fetch } = sequence(json(409, { error: { code: "quote_drifted", message: "m" } }));
  const error = await caught(make(fetch).closePlan({ source: "G1", destination: "G2" }));

  expect(isApiErrorCode(error, "quote_drifted")).toBe(true);
  expect(isApiErrorCode(error, "rate_limited")).toBe(false);
  expect(isApiErrorCode(new Error("quote_drifted"), "quote_drifted")).toBe(false);
});

test("a caller abort rejects with LumenWipeAbortError, a timeout with LumenWipeTimeoutError", async () => {
  const controller = new AbortController();
  const aborted = make(hangingFetch(), { timeout: 5000 }).getAccount("GABC", undefined, {
    signal: controller.signal,
  });
  controller.abort(new Error("navigated away"));
  const abortError = await caught(aborted);
  expect(abortError).toBeInstanceOf(LumenWipeAbortError);
  expect(abortError).not.toBeInstanceOf(LumenWipeTimeoutError);

  const timeoutError = await caught(make(hangingFetch(), { timeout: 10 }).getAccount("GABC"));
  expect(timeoutError).toBeInstanceOf(LumenWipeTimeoutError);
  expect(timeoutError).not.toBeInstanceOf(LumenWipeAbortError);
});

test("an already-aborted signal rejects without calling fetch", async () => {
  const { fetch, calls } = sequence();
  const error = await caught(make(fetch).submit("XDR", undefined, { signal: AbortSignal.abort() }));
  expect(error).toBeInstanceOf(LumenWipeAbortError);
  expect(calls).toHaveLength(0);
});

test("retries are off by default", async () => {
  const { fetch, calls } = sequence(json(503, envelope), json(200, {}));
  await caught(make(fetch).getAccount("GABC"));
  expect(calls).toHaveLength(1);
});

test("retry repeats a GET after a network error and a 503", async () => {
  const { fetch, calls } = sequence(
    new TypeError("fetch failed"),
    json(503, envelope),
    json(200, { ok: 1 })
  );
  const client = make(fetch, { retry: { attempts: 3, baseDelayMs: 1 } });
  expect(await client.getAccount("GABC")).toEqual({ ok: 1 } as never);
  expect(calls).toHaveLength(3);
});

test("retry repeats a stateless POST on 429 and honors Retry-After over backoff", async () => {
  const { fetch, calls } = sequence(
    json(429, envelope, { "Retry-After": "0" }),
    json(200, { planHash: "h" })
  );
  const client = make(fetch, { retry: { attempts: 2, baseDelayMs: 600_000 } });
  await client.closePlan({ source: "G1", destination: "G2" });
  expect(calls).toHaveLength(2);
});

test("retry does not repeat a stateless POST on a 500 or a network error", async () => {
  const client = (f: FetchLike): LumenWipeClient =>
    make(f, { retry: { attempts: 3, baseDelayMs: 1 } });
  const a = sequence(json(500, envelope), json(200, {}));
  await caught(client(a.fetch).closeTransactions({ source: "G1", destination: "G2" }));
  expect(a.calls).toHaveLength(1);
  const b = sequence(new TypeError("fetch failed"), json(200, {}));
  await caught(client(b.fetch).feeBumpSponsor("XDR"));
  expect(b.calls).toHaveLength(1);
});

test("retry stops after the configured attempts and throws the last error", async () => {
  const { fetch, calls } = sequence(json(503, envelope), json(503, envelope));
  const error = await caught(
    make(fetch, { retry: { attempts: 2, baseDelayMs: 1 } }).getAccount("GABC")
  );
  expect(error).toBeInstanceOf(LumenWipeApiError);
  expect(calls).toHaveLength(2);
});

test("submit and mediatorSign are never retried, even on 429 and 503", async () => {
  for (const status of [429, 503]) {
    const retry = { attempts: 5, baseDelayMs: 1 };
    const s = sequence(json(status, envelope, { "Retry-After": "0" }), json(200, {}));
    await caught(make(s.fetch, { retry }).submit("XDR"));
    expect(s.calls).toHaveLength(1);

    const m = sequence(json(status, envelope, { "Retry-After": "0" }), json(200, {}));
    await caught(make(m.fetch, { retry }).mediatorSign("XDR"));
    expect(m.calls).toHaveLength(1);
  }
  const net = sequence(new TypeError("fetch failed"), json(200, {}));
  await caught(make(net.fetch, { retry: { attempts: 5, baseDelayMs: 1 } }).submit("XDR"));
  expect(net.calls).toHaveLength(1);
});

test("an abort during the retry wait rejects with LumenWipeAbortError", async () => {
  const { fetch, calls } = sequence(json(503, envelope), json(200, {}));
  const controller = new AbortController();
  const pending = make(fetch, { retry: { attempts: 2, baseDelayMs: 600_000 } }).getAccount(
    "GABC",
    undefined,
    { signal: controller.signal }
  );
  setTimeout(() => controller.abort(), 20);
  expect(await caught(pending)).toBeInstanceOf(LumenWipeAbortError);
  expect(calls).toHaveLength(1);
});

test("every request carries the SDK identification header matching package.json", async () => {
  const { version } = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8")
  ) as { version: string };
  const { fetch, calls } = sequence(json(200, {}), json(200, {}));
  const client = make(fetch);
  await client.health();
  await client.submit("XDR");
  for (const call of calls) {
    expect((call.init?.headers as Record<string, string>)["X-LumenWipe-SDK"]).toBe(
      `sdk/${version}`
    );
  }
});

test("omitting network logs one notice and defaults to testnet; an explicit network stays quiet", async () => {
  const messages: string[] = [];
  const logger = (m: string): void => void messages.push(m);
  const { fetch, calls } = sequence(json(200, {}), json(200, {}), json(200, {}));
  const client = new LumenWipeClient({ baseUrl: "https://x", apiKey: "k", fetch, logger });
  await client.getAccount("A");
  await client.getAccount("B");
  expect(calls[0].url).toBe("https://x/testnet/account/A");
  expect(messages).toHaveLength(1);

  await client.getAccount("C", "mainnet");
  expect(messages).toHaveLength(1);

  const quiet: string[] = [];
  const explicit = new LumenWipeClient({
    baseUrl: "https://x",
    apiKey: "k",
    network: "mainnet",
    fetch: sequence(json(200, {})).fetch,
    logger: (m) => void quiet.push(m),
  });
  await explicit.getAccount("A");
  expect(quiet).toHaveLength(0);
});

test("a plaintext non-local baseUrl warns; https and loopback hosts do not", () => {
  const warned = (baseUrl: string): number => {
    const messages: string[] = [];
    make(sequence().fetch, { baseUrl, logger: (m) => void messages.push(m) });
    return messages.length;
  };
  expect(warned("http://api.example.com")).toBe(1);
  expect(warned("https://api.example.com")).toBe(0);
  expect(warned("http://localhost:3001")).toBe(0);
  expect(warned("http://127.0.0.1:3001")).toBe(0);
  expect(warned("http://[::1]:3001")).toBe(0);
});
