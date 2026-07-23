import { expect, test } from "bun:test";
import { LumenWipeApiError, LumenWipeClient, type FetchLike } from "../../src/index";

interface Call {
  url: string;
  init?: RequestInit;
}

function mockFetch(status: number, body: unknown): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  };
  return { fetch, calls };
}

function mockRawFetch(status: number, text: string): FetchLike {
  return () => Promise.resolve(new Response(text, { status }));
}

test("closePlan posts to the v1 path with the bearer key and JSON body", async () => {
  const { fetch, calls } = mockFetch(200, { planHash: "h1", status: "ready" });
  const client = new LumenWipeClient({ baseUrl: "https://api.example.com/", apiKey: "k", fetch });

  const res = await client.closePlan({ source: "GABC" });

  expect(res).toMatchObject({ planHash: "h1", status: "ready" });
  expect(calls[0].url).toBe("https://api.example.com/v1/testnet/close/plan"); // trailing slash stripped
  expect(calls[0].init?.method).toBe("POST");
  expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer k");
  expect((calls[0].init?.headers as Record<string, string>)["Content-Type"]).toBe(
    "application/json"
  );
  expect(JSON.parse(calls[0].init?.body as string)).toEqual({ source: "GABC" });
});

test("submit relays the signed XDR string", async () => {
  const { fetch, calls } = mockFetch(200, { status: "success", hash: "abc", ledger: 42 });
  const client = new LumenWipeClient({ baseUrl: "https://x", apiKey: "k", fetch });

  const res = await client.submit("AAAA...signed");

  expect(res).toEqual({ status: "success", hash: "abc", ledger: 42 });
  expect(JSON.parse(calls[0].init?.body as string)).toEqual({ signedXdr: "AAAA...signed" });
});

test("getPaths builds the query string and respects the network override", async () => {
  const { fetch, calls } = mockFetch(200, { path: null });
  const client = new LumenWipeClient({ baseUrl: "https://x", apiKey: "k", fetch });

  await client.getPaths({ fromAsset: "USDC:GISS", amount: "10" }, "mainnet");

  expect(calls[0].url).toBe("https://x/mainnet/paths?fromAsset=USDC%3AGISS&amount=10");
  expect(calls[0].init?.method).toBe("GET");
});

test("GET requests carry no Content-Type and no body", async () => {
  const { fetch, calls } = mockFetch(200, {});
  const client = new LumenWipeClient({ baseUrl: "https://x", apiKey: "k", fetch });

  await client.getAccount("GABC");

  expect(calls[0].url).toBe("https://x/testnet/account/GABC");
  expect(calls[0].init?.body).toBeUndefined();
  expect((calls[0].init?.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
});

test("a non-2xx response throws LumenWipeApiError with status and parsed body", async () => {
  const { fetch } = mockFetch(401, { error: { code: "unauthorized", message: "A valid API key is required." } });
  const client = new LumenWipeClient({ baseUrl: "https://x", apiKey: "bad", fetch });

  let error: unknown;
  try {
    await client.getAccount("GABC");
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(LumenWipeApiError);
  expect((error as LumenWipeApiError).status).toBe(401);
  expect((error as LumenWipeApiError).body).toEqual({
    error: { code: "unauthorized", message: "A valid API key is required." },
  });
});

test("a non-JSON error body (e.g. a proxy 502) still throws LumenWipeApiError with the raw text", async () => {
  const client = new LumenWipeClient({
    baseUrl: "https://x",
    apiKey: "k",
    fetch: mockRawFetch(502, "<html>502 Bad Gateway</html>"),
  });

  let error: unknown;
  try {
    await client.submit("AAAA...signed");
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(LumenWipeApiError);
  expect((error as LumenWipeApiError).status).toBe(502);
  expect((error as LumenWipeApiError).body).toBe("<html>502 Bad Gateway</html>");
});
