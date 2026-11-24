import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { GET } from "@/app/api/status/route";
import { fakeFetch } from "./fixtures/fetch";
import { HOSTED_MALFORMED, HOSTED_MIXED } from "./fixtures/status/hosted-pages";
import { MALFORMED, RPC_DEGRADED, WITH_EXTRAS } from "./fixtures/status/summaries";

const SOURCE = "https://status.example.test/summary.json";
const CACHE_CONTROL = "public, s-maxage=60";

let saved: string | undefined;
let requests: { url: string; init?: RequestInit }[];

function answer(handler: () => Response | Promise<Response>): void {
  spyOn(globalThis, "fetch").mockImplementation(
    fakeFetch((url, init) => {
      requests.push({ url, init });
      return handler();
    })
  );
}

async function expectNothingToShow(): Promise<void> {
  const res = await GET();
  expect(res.status).toBe(204);
  expect(await res.text()).toBe("");
  expect(res.headers.get("Cache-Control")).toBe(CACHE_CONTROL);
}

beforeEach(() => {
  saved = process.env.STATUS_SOURCE_URL;
  process.env.STATUS_SOURCE_URL = SOURCE;
  requests = [];
});

afterEach(() => {
  if (saved === undefined) delete process.env.STATUS_SOURCE_URL;
  else process.env.STATUS_SOURCE_URL = saved;
  mock.restore();
});

test("status route › a summary is served with the status page origin, cached for 60 seconds", async () => {
  answer(() => Response.json(WITH_EXTRAS));
  const res = await GET();
  expect(res.status).toBe(200);
  expect(res.headers.get("Cache-Control")).toBe(CACHE_CONTROL);
  expect(await res.json()).toEqual({
    components: [{ id: "api", state: "degraded" }],
    page: "https://status.example.test",
  });
  expect(requests.map((r) => r.url)).toEqual([SOURCE]);
});

test("status route › the host is read without following redirects, within 3 seconds", async () => {
  const controller = new AbortController();
  const timeout = spyOn(AbortSignal, "timeout").mockImplementation(() => controller.signal);
  answer(() => Response.json(RPC_DEGRADED));
  await GET();
  expect(requests[0]!.init?.redirect).toBe("error");
  expect(requests[0]!.init?.signal).toBe(controller.signal);
  expect(timeout.mock.calls[0]![0]).toBeLessThanOrEqual(3_000);
});

test.each([
  ["unset", undefined],
  ["empty", ""],
  ["plain http", "http://status.example.test/summary.json"],
  ["ftp", "ftp://status.example.test/summary.json"],
  ["not a URL", "status.example.test"],
])("status route › a source that is %s is never fetched", async (_, value) => {
  if (value === undefined) delete process.env.STATUS_SOURCE_URL;
  else process.env.STATUS_SOURCE_URL = value;
  answer(() => Response.json(RPC_DEGRADED));
  await expectNothingToShow();
  expect(requests).toEqual([]);
});

test("status route › an unreachable host shows nothing", async () => {
  answer(() => {
    throw new TypeError("fetch failed");
  });
  await expectNothingToShow();
});

test("status route › a host that times out or redirects shows nothing", async () => {
  answer(() => {
    throw new DOMException("The operation timed out.", "TimeoutError");
  });
  await expectNothingToShow();
});

test("status route › an error status shows nothing", async () => {
  answer(() => Response.json(RPC_DEGRADED, { status: 503 }));
  await expectNothingToShow();
});

test("status route › a body that is not JSON shows nothing", async () => {
  answer(() => new Response("<html>maintenance</html>", { status: 200 }));
  await expectNothingToShow();
});

test.each(MALFORMED.map((body) => [JSON.stringify(body), body]))(
  "status route › %s shows nothing",
  async (_, body) => {
    answer(() => Response.json(body));
    await expectNothingToShow();
  }
);

test("status route › a hosted status page served as text/html is mapped onto the summary", async () => {
  answer(
    () =>
      new Response(JSON.stringify(HOSTED_MIXED), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      })
  );
  const res = await GET();
  expect(res.status).toBe(200);
  expect(res.headers.get("Cache-Control")).toBe(CACHE_CONTROL);
  expect(await res.json()).toEqual({
    components: [
      { id: "api", state: "operational" },
      { id: "web", state: "degraded" },
      { id: "user-path", state: "outage" },
      { id: "rpc-mainnet", state: "degraded" },
      { id: "indexer", state: "operational" },
    ],
    page: "https://status.example.test",
  });
});

test.each(HOSTED_MALFORMED)(
  "status route › a hosted status page with %s shows nothing",
  async (_, body) => {
    answer(() => Response.json(body));
    await expectNothingToShow();
  }
);
