import { expect, test } from "bun:test";
import {
  LumenWipeApiError,
  LumenWipeIntegratorClient,
  type FetchLike,
  type IntegratorKeyList,
} from "../../src/index";
import { SDK_VERSION } from "../../src/version";

interface Call {
  url: string;
  init: RequestInit;
}

const TOKEN = "lws.session-token-secret";

function fake(status: number | ((call: number) => number), body: unknown = {}) {
  const calls: Call[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, init: init ?? {} });
    const code = typeof status === "number" ? status : status(calls.length);
    return Promise.resolve(new Response(JSON.stringify(body), { status: code }));
  };
  return { calls, fetch };
}

function client(
  fetch: FetchLike,
  extra: { retry?: { attempts: number; baseDelayMs: number } } = {}
) {
  return new LumenWipeIntegratorClient({ baseUrl: "https://api.test/", fetch, ...extra });
}

test("challenge and session post their bodies with no Authorization at all", async () => {
  const { calls, fetch } = fake(200, { message: "m", expiresAt: "t" });
  const c = client(fetch);
  await c.challenge("GABC");
  await c.session({ address: "GABC", message: "m", signature: "s" });

  expect(calls.map((x) => [x.init.method, x.url, x.init.body])).toEqual([
    ["POST", "https://api.test/v1/integrator/auth/challenge", '{"address":"GABC"}'],
    [
      "POST",
      "https://api.test/v1/integrator/auth/session",
      '{"address":"GABC","message":"m","signature":"s"}',
    ],
  ]);
  for (const call of calls) {
    expect(call.init.headers).toEqual({
      "X-LumenWipe-SDK": `sdk/${SDK_VERSION}`,
      "Content-Type": "application/json",
    });
  }
});

test("listKeys sends the session token as the only credential and returns keys with usage", async () => {
  const list: IntegratorKeyList = {
    keys: [
      {
        id: "h1",
        createdAt: "2026-11-01T00:00:00.000Z",
        revokedAt: null,
        rotatedFrom: null,
        label: "prod",
        networks: ["mainnet"],
        lastUsedAt: null,
        usage: { today: 1, last30Days: 9, rateLimitedLast30Days: 2 },
      },
    ],
    usage: { today: 1, last30Days: 9 },
  };
  const { calls, fetch } = fake(200, list);
  expect(await client(fetch).listKeys(TOKEN)).toEqual(list);
  expect(calls[0].url).toBe("https://api.test/v1/integrator/keys");
  expect(calls[0].init.method).toBe("GET");
  expect(calls[0].init.body).toBeUndefined();
  expect(calls[0].init.headers).toEqual({
    Authorization: `Bearer ${TOKEN}`,
    "X-LumenWipe-SDK": `sdk/${SDK_VERSION}`,
  });
});

test("createKey sends an empty body by default and the label and networks when given", async () => {
  const { calls, fetch } = fake(201, { key: "lw_x", record: {} });
  const c = client(fetch);
  await c.createKey(TOKEN);
  await c.createKey(TOKEN, { label: "ci", networks: ["testnet"] });
  expect(calls.map((x) => x.init.body)).toEqual(["{}", '{"label":"ci","networks":["testnet"]}']);
  expect(calls.every((x) => x.url === "https://api.test/v1/integrator/keys")).toBe(true);
  expect(
    calls.every(
      (x) => (x.init.headers as Record<string, string>).Authorization === `Bearer ${TOKEN}`
    )
  ).toBe(true);
});

test("revokeKey and rotateKey percent-encode the id", async () => {
  const { calls, fetch } = fake(200, { status: "revoked" });
  const c = client(fetch);
  await c.revokeKey(TOKEN, "a/../b?c#d");
  await c.rotateKey(TOKEN, "a b");
  expect(calls.map((x) => [x.init.method, x.url, x.init.body])).toEqual([
    ["POST", "https://api.test/v1/integrator/keys/a%2F..%2Fb%3Fc%23d/revoke", undefined],
    ["POST", "https://api.test/v1/integrator/keys/a%20b/rotate", undefined],
  ]);
});

test("creating, revoking and rotating a key are never retried; listing is", async () => {
  const retry = { attempts: 3, baseDelayMs: 0 };
  for (const call of [
    (c: LumenWipeIntegratorClient) => c.createKey(TOKEN),
    (c: LumenWipeIntegratorClient) => c.revokeKey(TOKEN, "h"),
    (c: LumenWipeIntegratorClient) => c.rotateKey(TOKEN, "h"),
  ]) {
    const { calls, fetch } = fake(503);
    await expect(call(client(fetch, { retry }))).rejects.toBeInstanceOf(LumenWipeApiError);
    expect(calls).toHaveLength(1);
  }
  const { calls, fetch } = fake((n) => (n === 1 ? 503 : 200), { keys: [], usage: null });
  await client(fetch, { retry }).listKeys(TOKEN);
  expect(calls).toHaveLength(2);
});

test("the session token never reaches a log line or an error", async () => {
  const logs: string[] = [];
  const { fetch } = fake(401, { error: { code: "unauthorized", message: "Session expired." } });
  const c = new LumenWipeIntegratorClient({
    baseUrl: "http://api.example.com",
    fetch,
    logger: (m) => logs.push(m),
  });
  const error = (await c.listKeys(TOKEN).catch((e: unknown) => e)) as LumenWipeApiError;

  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain("http://");
  expect(error).toBeInstanceOf(LumenWipeApiError);
  expect(error.code).toBe("unauthorized");
  const surfaced = [...logs, error.message, String(error.stack), JSON.stringify(error)].join("\n");
  expect(surfaced).not.toContain(TOKEN);
});
