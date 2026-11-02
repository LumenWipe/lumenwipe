import { expect, mock, test } from "bun:test";
import { NextResponse } from "next/server";
import { LumenWipeApiError } from "@lumenwipe/sdk";
import { invalidNetworkResponse } from "@/lib/api/network-segment";
import { proxyErrorResponse } from "@/lib/api/proxy-error";
import { transactionLookupResponse } from "@/lib/api/transaction-lookup";

const HASH = "a".repeat(64);
const open = async (): Promise<null> => null;

test("an unknown network, as the shared check answers it, stops everything and is not cached", async () => {
  const relay = mock(async () => NextResponse.json({}));
  const res = await transactionLookupResponse("not-a-hash", {
    rateLimit: async () => invalidNetworkResponse(),
    relay,
  });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_network");
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(relay).not.toHaveBeenCalled();
});

test("a malformed hash is refused before the API", async () => {
  const relay = mock(async () => NextResponse.json({}));
  const res = await transactionLookupResponse("not-a-hash", { rateLimit: open, relay });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_tx_hash");
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(relay).not.toHaveBeenCalled();
});

test("the proxy's rate limit applies and its 429 is not cached", async () => {
  const relay = mock(async () => NextResponse.json({}));
  const res = await transactionLookupResponse(HASH, {
    rateLimit: async () => new NextResponse("{}", { status: 429 }),
    relay,
  });
  expect(res.status).toBe(429);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(relay).not.toHaveBeenCalled();
});

test("a well-formed hash under the limit is relayed", async () => {
  const res = await transactionLookupResponse(HASH, {
    rateLimit: open,
    relay: async () => NextResponse.json({ status: "confirmed" }),
  });
  expect(res.status).toBe(200);
});

test("every proxied error is uncacheable", () => {
  for (const failure of [
    new LumenWipeApiError(503, { error: { code: "service_unavailable", message: "x" } }),
    new TypeError("fetch failed"),
  ]) {
    expect(proxyErrorResponse(failure).headers.get("Cache-Control")).toBe("no-store");
  }
});
