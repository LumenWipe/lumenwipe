import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { NextRequest, type NextResponse } from "next/server";
import { Keypair } from "@stellar/stellar-sdk";
import * as challengeRoute from "@/app/api/integrator/auth/challenge/route";
import * as sessionRoute from "@/app/api/integrator/auth/session/route";
import * as keysRoute from "@/app/api/integrator/keys/route";
import * as rotateRoute from "@/app/api/integrator/keys/[id]/rotate/route";
import { SESSION_COOKIE } from "@/lib/integrator/session-cookie";

const SITE = "https://www.lumenwipe.com";
const APP_URL = "https://app.lumenwipe.test";
const UPSTREAM = "https://upstream.invalid";
const LIMITER = "https://limiter.invalid";
const ENV: Record<string, string> = {
  LUMENWIPE_API_URL: UPSTREAM,
  NEXT_PUBLIC_APP_URL: APP_URL,
  UPSTASH_REDIS_REST_URL: LIMITER,
  UPSTASH_REDIS_REST_TOKEN: "test-token",
};

const ADDRESS = Keypair.random().publicKey();
const OTHER = Keypair.random().publicKey();
const exp = () => Math.floor(Date.now() / 1000) + 1800;
const token = (address = ADDRESS) => `lws.${address}.${exp()}.c2Vzc2lvbi1tYWM`;

interface UpstreamReply {
  status: number;
  body: unknown;
}

let fetchSpy: ReturnType<typeof spyOn>;
let limiterCount = 1;
let upstream: UpstreamReply = { status: 200, body: {} };
const saved = new Map<string, string | undefined>();

function originOf(input: unknown): string | null {
  try {
    return new URL(String(input)).origin;
  } catch {
    return null;
  }
}

function upstreamCalls(): { url: string; init: RequestInit }[] {
  return (fetchSpy.mock.calls as [unknown, RequestInit][])
    .filter(([input]) => originOf(input) === new URL(UPSTREAM).origin)
    .map(([input, init]) => ({ url: String(input), init }));
}

interface Options {
  method?: string;
  origin?: string | null;
  contentType?: string | null;
  cookie?: string;
  authorization?: string;
  body?: string;
}

function request(path: string, options: Options = {}): NextRequest {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = {};
  const origin = options.origin === undefined ? SITE : options.origin;
  const contentType = options.contentType === undefined ? "application/json" : options.contentType;
  if (contentType !== null && method === "POST") headers["content-type"] = contentType;
  if (options.authorization) headers.authorization = options.authorization;
  const req = new NextRequest(`${SITE}/api/integrator/${path}`, {
    method,
    headers,
    body: method === "POST" ? (options.body ?? "{}") : undefined,
  });
  // The DOM test environment's Request drops forbidden headers (Origin, Cookie) passed to the
  // constructor, so they are set on the built request.
  if (origin !== null && method !== "GET") req.headers.set("origin", origin);
  if (options.cookie !== undefined) req.cookies.set(SESSION_COOKIE, options.cookie);
  return req;
}

function setCookie(res: Response): string {
  return res.headers.get("set-cookie") ?? "";
}

function expectCleared(res: Response): void {
  expect(setCookie(res)).toContain(`${SESSION_COOKIE}=;`);
  expect(setCookie(res)).toContain("Max-Age=0");
}

async function expectError(res: NextResponse, status: number, code: string): Promise<void> {
  expect(res.status).toBe(status);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  const body = (await res.json()) as { error: { code: string; message: string } };
  expect(body.error.code).toBe(code);
  expect(typeof body.error.message).toBe("string");
}

const signedBody = (address = ADDRESS) =>
  JSON.stringify({ address, message: "challenge", signature: "c2ln" });

beforeAll(() => {
  for (const [key, value] of Object.entries(ENV)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: unknown) => {
    if (originOf(input) === new URL(LIMITER).origin) {
      return Response.json([{ result: limiterCount }, { result: 1 }]);
    }
    return Response.json(upstream.body, { status: upstream.status });
  }) as unknown as typeof globalThis.fetch);
});

beforeEach(() => {
  fetchSpy.mockClear();
  limiterCount = 1;
  upstream = { status: 200, body: {} };
  process.env.LUMENWIPE_API_URL = UPSTREAM;
});

afterAll(() => {
  fetchSpy.mockRestore();
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("POST /api/integrator/auth/session", () => {
  test("sets the session cookie and returns only the address and expiry", async () => {
    const issued = token();
    upstream = { status: 200, body: { token: issued, expiresAt: "ignored" } };
    const res = await sessionRoute.POST(
      request("auth/session", { method: "POST", body: signedBody() })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const text = await res.text();
    expect(text).not.toContain("lws.");
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["address", "expiresAt"]);
    expect(body).not.toHaveProperty("token");
    expect(body.address).toBe(ADDRESS);

    const cookie = setCookie(res);
    expect(cookie).toContain(`${SESSION_COOKIE}=${issued}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toContain("Path=/api/integrator");
    expect(cookie).not.toMatch(/Domain=/i);

    const [call] = upstreamCalls();
    expect(call.url).toBe(`${UPSTREAM}/v1/integrator/auth/session`);
    expect((call.init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(call.init.body).toBe(signedBody());
  });

  test.each([
    ["a token for another address", () => token(OTHER)],
    ["a malformed token", () => "not-a-token"],
    ["no token", () => undefined],
  ])("answers 502 with no cookie for %s", async (_, makeToken) => {
    upstream = { status: 200, body: { token: makeToken(), expiresAt: "x" } };
    const res = await sessionRoute.POST(
      request("auth/session", { method: "POST", body: signedBody() })
    );
    await expectError(res, 502, "upstream_error");
    expect(setCookie(res)).toBe("");
  });

  test("relays a refused signature without setting a cookie", async () => {
    upstream = {
      status: 401,
      body: { error: { code: "invalid_challenge", message: "The signed challenge is invalid." } },
    };
    const res = await sessionRoute.POST(
      request("auth/session", { method: "POST", body: signedBody() })
    );
    await expectError(res, 401, "invalid_challenge");
    expect(setCookie(res)).toBe("");
  });
});

describe("GET and DELETE /api/integrator/auth/session", () => {
  test("GET restores the session from the cookie, with no upstream call", async () => {
    const res = await sessionRoute.GET(request("auth/session", { cookie: token() }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const text = await res.text();
    expect(text).not.toContain("lws.");
    expect(Object.keys(JSON.parse(text) as object).sort()).toEqual(["address", "expiresAt"]);
    expect(upstreamCalls()).toHaveLength(0);
  });

  test("GET without a usable cookie answers 401 and clears it", async () => {
    for (const cookie of [undefined, "garbage", `lws.${ADDRESS}.1.mac`]) {
      const res = await sessionRoute.GET(request("auth/session", { cookie }));
      await expectError(res, 401, "unauthorized");
      expectCleared(res);
    }
    expect(upstreamCalls()).toHaveLength(0);
  });

  test("DELETE clears the cookie with the same attributes", async () => {
    const res = await sessionRoute.DELETE(
      request("auth/session", { method: "DELETE", cookie: token() })
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expectCleared(res);
    expect(setCookie(res)).toContain("HttpOnly");
    expect(setCookie(res)).toContain("Path=/api/integrator");
  });

  test("DELETE from another origin is refused and clears nothing", async () => {
    const res = await sessionRoute.DELETE(
      request("auth/session", { method: "DELETE", origin: "https://evil.test", cookie: token() })
    );
    await expectError(res, 403, "forbidden_origin");
    expect(setCookie(res)).toBe("");
  });
});

describe("the keys routes", () => {
  test("send the cookie's token as the bearer credential", async () => {
    const session = token();
    upstream = { status: 200, body: { keys: [] } };
    const res = await keysRoute.GET(request("keys", { cookie: session }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const [call] = upstreamCalls();
    expect(call.url).toBe(`${UPSTREAM}/v1/integrator/keys`);
    expect((call.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${session}`);
  });

  test("ignore an Authorization header the browser sends", async () => {
    const session = token();
    await keysRoute.GET(
      request("keys", { cookie: session, authorization: `Bearer ${token(OTHER)}` })
    );
    const [call] = upstreamCalls();
    expect((call.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${session}`);
  });

  test("answer 401 without calling the API when there is no cookie, whatever the header", async () => {
    const res = await keysRoute.GET(request("keys", { authorization: `Bearer ${token()}` }));
    await expectError(res, 401, "unauthorized");
    expectCleared(res);
    expect(upstreamCalls()).toHaveLength(0);
  });

  test("clear the cookie when the API refuses the session", async () => {
    upstream = { status: 401, body: { error: { code: "unauthorized", message: "Expired." } } };
    const res = await keysRoute.GET(request("keys", { cookie: token() }));
    await expectError(res, 401, "unauthorized");
    expectCleared(res);
  });

  test("keep the cookie on any other API error", async () => {
    upstream = { status: 409, body: { error: { code: "key_limit_reached", message: "Five." } } };
    const res = await keysRoute.POST(request("keys", { method: "POST", cookie: token() }));
    await expectError(res, 409, "key_limit_reached");
    expect(setCookie(res)).toBe("");
  });

  test("rotate forwards the encoded id with the cookie's token", async () => {
    const session = token();
    upstream = { status: 200, body: { key: "k", record: {} } };
    await rotateRoute.POST(request("keys/a%2Fb/rotate", { method: "POST", cookie: session }), {
      params: Promise.resolve({ id: "a/b" }),
    });
    const [call] = upstreamCalls();
    expect(call.url).toBe(`${UPSTREAM}/v1/integrator/keys/a%2Fb/rotate`);
    expect((call.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${session}`);
  });
});

describe("state-changing requests", () => {
  const posts: [string, (req: NextRequest) => Promise<NextResponse>][] = [
    ["challenge", (req) => challengeRoute.POST(req)],
    ["session", (req) => sessionRoute.POST(req)],
    ["create key", (req) => keysRoute.POST(req)],
  ];

  test.each(posts)("%s refuses a missing, null or foreign Origin", async (_, handler) => {
    for (const origin of [null, "null", "https://evil.test", "https://www.lumenwipe.com.evil"]) {
      const res = await handler(request("x", { method: "POST", origin, cookie: token() }));
      await expectError(res, 403, "forbidden_origin");
    }
    expect(upstreamCalls()).toHaveLength(0);
  });

  test.each(posts)("%s accepts the configured app origin", async (_, handler) => {
    upstream = { status: 200, body: { message: "m", token: token(), expiresAt: "x" } };
    const res = await handler(
      request("x", { method: "POST", origin: APP_URL, cookie: token(), body: signedBody() })
    );
    expect(res.status).toBe(200);
  });

  test.each(posts)("%s refuses a body that is not JSON with 415", async (_, handler) => {
    for (const contentType of [null, "text/plain", "application/x-www-form-urlencoded"]) {
      const res = await handler(request("x", { method: "POST", contentType, cookie: token() }));
      await expectError(res, 415, "unsupported_media_type");
    }
    expect(upstreamCalls()).toHaveLength(0);
  });

  test("the rate limit runs first", async () => {
    limiterCount = 10_000;
    const res = await keysRoute.POST(request("keys", { method: "POST", origin: null }));
    await expectError(res, 429, "rate_limited");
    expect(upstreamCalls()).toHaveLength(0);
  });

  test("Origin is checked before the configuration, the configuration before the cookie", async () => {
    delete process.env.LUMENWIPE_API_URL;
    await expectError(
      await keysRoute.POST(request("keys", { method: "POST", origin: "https://evil.test" })),
      403,
      "forbidden_origin"
    );
    await expectError(
      await keysRoute.POST(request("keys", { method: "POST" })),
      503,
      "integrator_api_not_configured"
    );
  });
});
