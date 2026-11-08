import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { NextRequest } from "next/server";
import { DELETE, GET, PATCH, POST, PUT } from "@/app/api/csp-report/route";
import { CSP_REPORT_MAX_BYTES, blockedSource, violationLines } from "@/lib/api/csp-report";
import { PROXY_LIMIT_PER_DAY } from "@/lib/api/rate-limit";
import * as upstash from "@/lib/upstash-redis";

const URL_ = "https://www.lumenwipe.com/api/csp-report";
const ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

function violation(body: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "csp-violation",
    age: 1,
    url: `https://www.lumenwipe.com/testnet/analyze/${ACCOUNT}`,
    user_agent: "Mozilla/5.0",
    body: {
      documentURL: `https://www.lumenwipe.com/testnet/analyze/${ACCOUNT}`,
      referrer: `https://www.lumenwipe.com/?account=${ACCOUNT}`,
      sourceFile: `https://www.lumenwipe.com/_next/static/chunks/${ACCOUNT}.js`,
      sample: `fetch("/x?${ACCOUNT}")`,
      disposition: "enforce",
      statusCode: 200,
      lineNumber: 3,
      ...body,
    },
  };
}

function report(body: BodyInit, type = "application/reports+json"): NextRequest {
  return new NextRequest(URL_, { method: "POST", body, headers: { "content-type": type } });
}

let limiter: ReturnType<typeof spyOn<typeof upstash, "checkNamespacedRateLimit">>;
let warn: ReturnType<typeof spyOn<Console, "warn">>;
let logged: () => string;

beforeEach(() => {
  limiter = spyOn(upstash, "checkNamespacedRateLimit").mockResolvedValue("allowed");
  warn = spyOn(console, "warn").mockImplementation(() => {});
  logged = () => warn.mock.calls.map((call) => call.join(" ")).join("\n");
});

afterEach(() => {
  limiter.mockRestore();
  warn.mockRestore();
});

async function expectNoContent(res: Response): Promise<void> {
  expect(res.status).toBe(204);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(await res.text()).toBe("");
}

test("csp-report › logs each violation as its directive and the blocked origin only", async () => {
  const batch = [
    violation({
      effectiveDirective: "connect-src",
      blockedURL: `https://evil.example:8443/collect?account=${ACCOUNT}`,
    }),
    violation({ effectiveDirective: "script-src-elem", blockedURL: "inline" }),
  ];
  await expectNoContent(await POST(report(JSON.stringify(batch))));
  expect(warn.mock.calls).toEqual([
    ["CSP violation: connect-src blocked https://evil.example:8443"],
    ["CSP violation: script-src-elem blocked inline"],
  ]);
  expect(logged()).not.toContain(ACCOUNT);
});

test("csp-report › its limiter bucket is its own, never the close flow's", async () => {
  await POST(report("[]"));
  expect(limiter).toHaveBeenCalledTimes(1);
  const [namespace, , limit] = limiter.mock.calls[0]!;
  expect(namespace).toBe("proxy:csp-report");
  expect(limit).toBe(100);
  expect(limit).toBeLessThan(PROXY_LIMIT_PER_DAY);
});

test("csp-report › over the limit it answers 429 and logs nothing", async () => {
  limiter.mockResolvedValue("limited");
  const batch = [violation({ effectiveDirective: "img-src", blockedURL: "https://a.example/" })];
  const res = await POST(report(JSON.stringify(batch)));
  expect(res.status).toBe(429);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(await res.text()).not.toContain("a.example");
  expect(warn).not.toHaveBeenCalled();
});

test("csp-report › a body over the cap is dropped unread, declared or not", async () => {
  const big = JSON.stringify([
    violation({ effectiveDirective: "img-src", blockedURL: "https://a.example/" }),
    "x".repeat(CSP_REPORT_MAX_BYTES),
  ]);
  await expectNoContent(await POST(report(big)));

  const small = JSON.stringify([
    violation({ effectiveDirective: "img-src", blockedURL: "https://a.example/" }),
  ]);
  // Bun drops a content-length set on a constructed request; the server sets it from the wire.
  const declared = report(small);
  const read = declared.headers.get.bind(declared.headers);
  spyOn(declared.headers, "get").mockImplementation((name) =>
    name.toLowerCase() === "content-length" ? String(CSP_REPORT_MAX_BYTES + 1) : read(name)
  );
  await expectNoContent(await POST(declared));
  expect(declared.bodyUsed).toBe(false);

  const chunk = new TextEncoder().encode(`[${" ".repeat(4096)}`);
  let pulled = 0;
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      controller.enqueue(chunk);
    },
  });
  const streamed = new NextRequest(URL_, {
    method: "POST",
    body: endless,
    headers: { "content-type": "application/reports+json" },
    duplex: "half",
  } as ConstructorParameters<typeof NextRequest>[1]);
  await expectNoContent(await POST(streamed));
  expect(pulled * chunk.byteLength).toBeLessThanOrEqual(
    CSP_REPORT_MAX_BYTES + 3 * chunk.byteLength
  );
  expect(warn).not.toHaveBeenCalled();
});

test("csp-report › a wrong content type is ignored before the limiter is asked", async () => {
  const batch = [violation({ effectiveDirective: "img-src", blockedURL: "https://a.example/" })];
  await expectNoContent(await POST(report(JSON.stringify(batch), "application/json")));
  expect(limiter).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
});

test("csp-report › malformed JSON, other report types and unknown directives are ignored", async () => {
  for (const body of [
    "{not json",
    JSON.stringify({ not: "an array" }),
    JSON.stringify([{ type: "deprecation", body: { id: "x" } }]),
    JSON.stringify([violation({ effectiveDirective: `img-src ${ACCOUNT}`, blockedURL: "x" })]),
    JSON.stringify([null, 3, { type: "csp-violation" }]),
  ]) {
    await expectNoContent(await POST(report(body)));
  }
  expect(warn).not.toHaveBeenCalled();
});

test("csp-report › every method but POST is refused, uncached", async () => {
  for (const handler of [GET, PUT, PATCH, DELETE]) {
    const res = handler();
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  }
});

test("csp-report › a blocked URL is reduced to its origin, scheme or keyword", () => {
  expect(blockedSource(`https://a.example/path/${ACCOUNT}?q=1#h`)).toBe("https://a.example");
  expect(blockedSource("wss://relay.example/socket")).toBe("wss://relay.example");
  expect(blockedSource("chrome-extension://abcdefghijklmnop/inject.js")).toBe("chrome-extension:");
  expect(blockedSource("data:text/javascript,alert(1)")).toBe("data:");
  expect(blockedSource("blob:https://www.lumenwipe.com/uuid")).toBe("blob:");
  expect(blockedSource("eval")).toBe("eval");
  expect(blockedSource(`not a url ${ACCOUNT}`)).toBe("other");
  expect(blockedSource(undefined)).toBe("other");
});

test("csp-report › one batch logs at most twenty violations", () => {
  const batch = Array.from({ length: 50 }, () =>
    violation({ effectiveDirective: "img-src", blockedURL: "https://a.example/" })
  );
  expect(violationLines(batch)).toHaveLength(20);
});
