import { expect, test } from "bun:test";
import {
  LumenWipeApiError,
  LumenWipeClient,
  LumenWipeInvalidNetworkError,
  LumenWipeTimeoutError,
  type ClosePlanRequest,
  type CloseTransactionsRequest,
  type FetchLike,
  type Network,
} from "../../src/index";

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

/** A fetch that never resolves, but rejects (like real fetch) when the signal aborts. */
function hangingFetch(): FetchLike {
  return (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("The operation was aborted.", "AbortError"))
      );
    });
}

test("closePlan posts to the v1 path with the bearer key and JSON body", async () => {
  const { fetch, calls } = mockFetch(200, { planHash: "h1", status: "ready" });
  const client = new LumenWipeClient({
    baseUrl: "https://api.example.com/",
    apiKey: "k",
    network: "testnet",
    fetch,
  });

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
  const client = new LumenWipeClient({
    baseUrl: "https://x",
    apiKey: "k",
    network: "testnet",
    fetch,
  });

  const res = await client.submit("AAAA...signed");

  expect(res).toEqual({ status: "success", hash: "abc", ledger: 42 });
  expect(JSON.parse(calls[0].init?.body as string)).toEqual({ signedXdr: "AAAA...signed" });
});

test("getPaths builds the query string and respects the network override", async () => {
  const { fetch, calls } = mockFetch(200, { path: null });
  const client = new LumenWipeClient({
    baseUrl: "https://x",
    apiKey: "k",
    network: "testnet",
    fetch,
  });

  await client.getPaths({ fromAsset: "USDC:GISS", amount: "10" }, "mainnet");

  expect(calls[0].url).toBe("https://x/mainnet/paths?fromAsset=USDC%3AGISS&amount=10");
  expect(calls[0].init?.method).toBe("GET");
});

test("getAllowances GETs the network-scoped path", async () => {
  const { fetch, calls } = mockFetch(200, { allowances: [] });
  const client = new LumenWipeClient({
    baseUrl: "https://x",
    apiKey: "k",
    network: "testnet",
    fetch,
  });

  await client.getAllowances("GABC", "mainnet");

  expect(calls[0].url).toBe("https://x/mainnet/allowances/GABC");
  expect(calls[0].init?.method).toBe("GET");
});

test("revokeAllowance posts owner/token/spender to the revoke path", async () => {
  const { fetch, calls } = mockFetch(200, { transaction: "AAAA" });
  const client = new LumenWipeClient({
    baseUrl: "https://x",
    apiKey: "k",
    network: "testnet",
    fetch,
  });

  await client.revokeAllowance({ owner: "GABC", token: "CABC", spender: "CDEF" }, "testnet");

  expect(calls[0].url).toBe("https://x/testnet/allowances/revoke");
  expect(calls[0].init?.method).toBe("POST");
  expect(JSON.parse(calls[0].init?.body as string)).toEqual({
    owner: "GABC",
    token: "CABC",
    spender: "CDEF",
  });
});

test("GET requests carry no Content-Type and no body", async () => {
  const { fetch, calls } = mockFetch(200, {});
  const client = new LumenWipeClient({
    baseUrl: "https://x",
    apiKey: "k",
    network: "testnet",
    fetch,
  });

  await client.getAccount("GABC");

  expect(calls[0].url).toBe("https://x/testnet/account/GABC");
  expect(calls[0].init?.body).toBeUndefined();
  expect((calls[0].init?.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
});

test("a non-2xx response throws LumenWipeApiError with status and parsed body", async () => {
  const { fetch } = mockFetch(401, {
    error: { code: "unauthorized", message: "A valid API key is required." },
  });
  const client = new LumenWipeClient({
    baseUrl: "https://x",
    apiKey: "bad",
    network: "testnet",
    fetch,
  });

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
    network: "testnet",
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

test("a request that exceeds the timeout throws LumenWipeTimeoutError", async () => {
  const client = new LumenWipeClient({
    baseUrl: "https://x",
    apiKey: "k",
    network: "testnet",
    timeout: 10,
    fetch: hangingFetch(),
  });

  let error: unknown;
  try {
    await client.getAccount("GABC");
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(LumenWipeTimeoutError);
  expect((error as LumenWipeTimeoutError).timeoutMs).toBe(10);
});

const NETWORK_CALLS: [string, (client: LumenWipeClient, network: Network) => Promise<unknown>][] = [
  ["getAccount", (c, n) => c.getAccount("G", n)],
  ["getPaths", (c, n) => c.getPaths({ fromAsset: "a", amount: "1" }, n)],
  ["closePlan", (c, n) => c.closePlan({} as ClosePlanRequest, n)],
  ["closeTransactions", (c, n) => c.closeTransactions({} as CloseTransactionsRequest, n)],
  ["submit", (c, n) => c.submit("xdr", n)],
  ["mediatorCheck", (c, n) => c.mediatorCheck("G", n)],
  ["mediatorSign", (c, n) => c.mediatorSign("xdr", n)],
  ["feeBumpSponsor", (c, n) => c.feeBumpSponsor("xdr", n)],
  ["getAllowances", (c, n) => c.getAllowances("G", n)],
  ["revokeAllowance", (c, n) => c.revokeAllowance({ owner: "G", token: "C", spender: "G" }, n)],
];

const UNKNOWN_NETWORKS = ["../admin", "testnet/../admin", "testnet?x=1#", "..", "", "TESTNET"];

test.each(NETWORK_CALLS)("%s rejects an unknown network with no request", async (_, call) => {
  const { fetch, calls } = mockFetch(200, {});
  const client = new LumenWipeClient({ baseUrl: "https://api.example.com", apiKey: "k", fetch });
  for (const network of [...UNKNOWN_NETWORKS, 1, {}, ["testnet"]]) {
    await expect(call(client, network as Network)).rejects.toBeInstanceOf(
      LumenWipeInvalidNetworkError
    );
  }
  expect(calls).toHaveLength(0);
});

test.each(NETWORK_CALLS)("%s accepts mainnet and testnet", async (_, call) => {
  const { fetch, calls } = mockFetch(200, {});
  const client = new LumenWipeClient({ baseUrl: "https://api.example.com", apiKey: "k", fetch });
  await call(client, "mainnet");
  await call(client, "testnet");
  expect(calls[0]?.url).toContain("/mainnet/");
  expect(calls[1]?.url).toContain("/testnet/");
});

test("an unknown network in the client options is rejected with no request", async () => {
  const { fetch, calls } = mockFetch(200, {});
  const client = new LumenWipeClient({
    baseUrl: "https://api.example.com",
    apiKey: "k",
    fetch,
    network: "../admin" as Network,
  });
  await expect(client.getAccount("G")).rejects.toBeInstanceOf(LumenWipeInvalidNetworkError);
  expect(calls).toHaveLength(0);
});
