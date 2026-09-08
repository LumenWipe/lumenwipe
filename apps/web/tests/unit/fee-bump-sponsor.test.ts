import { afterEach, expect, test } from "bun:test";
import { requestFeeBumpSponsorship } from "@/lib/stellar/fee-bump-sponsor";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function fakeFetch(status: number, body: unknown): typeof globalThis.fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof globalThis.fetch;
}

test("requestFeeBumpSponsorship › posts the signed xdr to the network-scoped route and returns the sponsored xdr", async () => {
  let calledUrl: string | undefined;
  let calledBody: unknown;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calledUrl = url;
    calledBody = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ transaction: "sponsored-xdr" }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;

  const result = await requestFeeBumpSponsorship("signed-xdr", "testnet");

  expect(result).toBe("sponsored-xdr");
  expect(calledUrl).toBe("/api/testnet/fee-bump/sponsor");
  expect(calledBody).toEqual({ transaction: "signed-xdr" });
});

test("requestFeeBumpSponsorship › surfaces the API's object-shaped error message", async () => {
  globalThis.fetch = fakeFetch(400, {
    error: { code: "operation_not_sponsorable", message: "That operation cannot be sponsored." },
  });

  await expect(requestFeeBumpSponsorship("signed-xdr", "testnet")).rejects.toThrow(
    "That operation cannot be sponsored."
  );
});

test("requestFeeBumpSponsorship › surfaces the API's string-shaped error", async () => {
  globalThis.fetch = fakeFetch(500, { error: "internal error" });

  await expect(requestFeeBumpSponsorship("signed-xdr", "testnet")).rejects.toThrow(
    "internal error"
  );
});

test("requestFeeBumpSponsorship › falls back to a default message when the error body is unrecognized", async () => {
  globalThis.fetch = fakeFetch(502, {});

  await expect(requestFeeBumpSponsorship("signed-xdr", "testnet")).rejects.toThrow(
    "Failed to obtain a sponsored fee for this transaction."
  );
});

test("requestFeeBumpSponsorship › throws when the response body isn't valid JSON", async () => {
  globalThis.fetch = (async () =>
    new Response("not json", { status: 502 })) as unknown as typeof globalThis.fetch;

  await expect(requestFeeBumpSponsorship("signed-xdr", "testnet")).rejects.toThrow(
    "Failed to obtain a sponsored fee for this transaction."
  );
});

test("requestFeeBumpSponsorship › rejects a 200 response with no transaction field", async () => {
  globalThis.fetch = fakeFetch(200, {});

  await expect(requestFeeBumpSponsorship("signed-xdr", "testnet")).rejects.toThrow(
    "The sponsor endpoint returned no transaction."
  );
});
