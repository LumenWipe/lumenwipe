import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { NextRequest, NextResponse } from "next/server";
import { LumenWipeApiError } from "@lumenwipe/sdk";
import { GET } from "@/app/api/v1/[network]/close/delivered/route";
import { deliveredLookupResponse, parseDeliveredQuery } from "@/lib/api/delivered-query";
import * as rateLimit from "@/lib/api/rate-limit";
import * as serverClient from "@/lib/api/server-client";

// The account with the all-zero key: a valid G address with its checksum.
const DEST = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const A = "a".repeat(64);
const B = "b".repeat(64);
const open = async (): Promise<null> => null;

function query(fields: Record<string, string | string[]>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    for (const v of Array.isArray(value) ? value : [value]) params.append(name, v);
  }
  return params;
}

test("a valid query is read as its destination and its hashes, lowercased", () => {
  expect(
    parseDeliveredQuery(query({ destination: DEST, hashes: `${A},${B.toUpperCase()}` }))
  ).toEqual({ ok: true, query: { destination: DEST, hashes: [A, B] } });
});

test("a destination that is missing, repeated or not an account is refused", () => {
  for (const destination of [[], [DEST, DEST], ["GABC"], [DEST.toLowerCase()], [`${DEST} `]]) {
    const parsed = parseDeliveredQuery(query({ destination, hashes: A }));
    expect(parsed.ok ? null : parsed.code).toBe("invalid_destination");
  }
});

test("hashes that are missing, repeated, malformed or too many are refused", () => {
  const five = Array.from({ length: 5 }, (_, i) => i.toString(16).padStart(64, "0"));
  expect(parseDeliveredQuery(query({ destination: DEST, hashes: five.join(",") })).ok).toBe(true);
  for (const hashes of [
    [],
    [A, B],
    "",
    `${A},`,
    `${A},${A.toUpperCase()}`,
    "a".repeat(63),
    "a".repeat(65),
    "g".repeat(64),
    `${A} `,
    [...five, "f".repeat(64)].join(","),
  ]) {
    const parsed = parseDeliveredQuery(query({ destination: DEST, hashes }));
    expect(parsed.ok ? null : parsed.code).toBe("invalid_tx_hash");
  }
});

test("the rate limit is judged first, and its refusal is not cached", async () => {
  const relay = mock(async () => NextResponse.json({}));
  const res = await deliveredLookupResponse(query({}), {
    rateLimit: async () => new NextResponse("{}", { status: 429 }),
    relay,
  });
  expect(res.status).toBe(429);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(relay).not.toHaveBeenCalled();
});

test("a refused query never reaches the API, and its 400 is not cached", async () => {
  const relay = mock(async () => NextResponse.json({}));
  const res = await deliveredLookupResponse(query({ destination: DEST, hashes: "x" }), {
    rateLimit: open,
    relay,
  });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_tx_hash");
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(relay).not.toHaveBeenCalled();
});

test("whatever the relay answers is not cached", async () => {
  const res = await deliveredLookupResponse(query({ destination: DEST, hashes: A }), {
    rateLimit: open,
    relay: async () => NextResponse.json({}, { headers: { "Cache-Control": "max-age=60" } }),
  });
  expect(res.headers.get("Cache-Control")).toBe("no-store");
});

let closeDelivered: ReturnType<typeof mock>;

beforeEach(() => {
  closeDelivered = mock(async () => ({ destination: DEST, entries: [] }));
  spyOn(rateLimit, "rateLimitProxy").mockImplementation((async () => null) as never);
  spyOn(serverClient, "getApiClient").mockImplementation(
    () => ({ closeDelivered }) as unknown as ReturnType<typeof serverClient.getApiClient>
  );
});

afterEach(() => mock.restore());

function call(search: string): Promise<NextResponse> {
  return GET(new NextRequest(`https://www.lumenwipe.com/api/v1/testnet/close/delivered${search}`), {
    params: Promise.resolve({ network: "testnet" }),
  });
}

test("the route forwards only the validated destination and hashes", async () => {
  const res = await call(
    `?network=mainnet&destination=${DEST}&hashes=${A.toUpperCase()},${B}&apiKey=x&extra=1`
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(closeDelivered).toHaveBeenCalledTimes(1);
  expect(closeDelivered.mock.calls[0]).toEqual([DEST, [A, B], "testnet"]);
});

test("the route forwards five hashes and refuses six before the API", async () => {
  const hashes = Array.from({ length: 6 }, (_, i) => String(i).repeat(64));
  const five = await call(`?destination=${DEST}&hashes=${hashes.slice(0, 5).join(",")}`);
  expect(five.status).toBe(200);
  expect(closeDelivered.mock.calls[0]).toEqual([DEST, hashes.slice(0, 5), "testnet"]);

  const six = await call(`?destination=${DEST}&hashes=${hashes.join(",")}`);
  expect(six.status).toBe(400);
  expect(((await six.json()) as { error: { code: string } }).error.code).toBe("invalid_tx_hash");
  expect(six.headers.get("Cache-Control")).toBe("no-store");
  expect(closeDelivered).toHaveBeenCalledTimes(1);
});

test("every answer of the route is uncacheable, its errors included", async () => {
  closeDelivered.mockImplementation(async () => {
    throw new LumenWipeApiError(503, { error: { code: "service_unavailable", message: "x" } });
  });
  const failed = await call(`?destination=${DEST}&hashes=${A}`);
  expect(failed.status).toBe(503);
  expect(failed.headers.get("Cache-Control")).toBe("no-store");

  const refused = await call(`?destination=${DEST}`);
  expect(refused.status).toBe(400);
  expect(refused.headers.get("Cache-Control")).toBe("no-store");

  spyOn(rateLimit, "rateLimitProxy").mockImplementation(
    (async () => new NextResponse("{}", { status: 429 })) as never
  );
  const limited = await call(`?destination=${DEST}&hashes=${A}`);
  expect(limited.status).toBe(429);
  expect(limited.headers.get("Cache-Control")).toBe("no-store");
  expect(closeDelivered).toHaveBeenCalledTimes(1);
});
