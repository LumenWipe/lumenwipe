import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type LighthouseResult,
  median,
  metricsOf,
  summarize,
  thirdPartyRequests,
  touchesWeb,
} from "@/scripts/lighthouse-report";

const WEB_ROOT = join(import.meta.dir, "..", "..");

function lhr({
  score = 0.9,
  lcp = 2000,
  cls = 0,
  tbt = 50,
  script = 300 * 1024,
  requests = [] as Array<{ url: string; statusCode: number }>,
} = {}): LighthouseResult {
  return {
    lighthouseVersion: "13.6.0",
    categories: { performance: { score } },
    audits: {
      "largest-contentful-paint": { numericValue: lcp },
      "cumulative-layout-shift": { numericValue: cls },
      "total-blocking-time": { numericValue: tbt },
      "resource-summary": {
        details: {
          items: [
            { resourceType: "total", transferSize: script * 2 },
            { resourceType: "script", transferSize: script },
          ],
        },
      },
      "network-requests": { details: { items: requests } },
    },
  };
}

test("lighthouse-report › the gate runs on a change to what the web app is built from", () => {
  expect(touchesWeb(["apps/web/app/(marketing)/layout.tsx"])).toBe(true);
  expect(touchesWeb(["apps/api/src/config/exchange-registry.json"])).toBe(true);
  expect(touchesWeb(["packages/sdk/src/index.ts"])).toBe(true);
  expect(touchesWeb(["bun.lock"])).toBe(true);
});

test("lighthouse-report › the gate skips a change outside the web app and an empty diff", () => {
  expect(touchesWeb(["docs/architecture.md", "apps/api/src/close/close.controller.ts"])).toBe(
    false
  );
  expect(touchesWeb(["apps/playground/app/page.tsx", ".github/workflows/ci.yml"])).toBe(false);
  expect(touchesWeb([])).toBe(false);
});

test("lighthouse-report › median takes the middle run, or the mean of the two middle ones", () => {
  expect(median([3000, 1000, 2000])).toBe(2000);
  expect(median([90, 70, 100, 80])).toBe(85);
  expect(() => median([])).toThrow();
});

test("lighthouse-report › metrics are read from the audits, and an unscored run is null", () => {
  expect(metricsOf(lhr({ score: 0.874, script: 2048 }))).toEqual({
    score: 87,
    lcpMs: 2000,
    cls: 0,
    tbtMs: 50,
    scriptBytes: 2048,
  });
  expect(metricsOf({ ...lhr(), categories: { performance: { score: null } } })).toBeNull();
});

test("lighthouse-report › third-party requests are listed as blocked or reached, local ones never", () => {
  const result = lhr({
    requests: [
      { url: "http://localhost:3000/_next/static/chunks/main.js", statusCode: 200 },
      { url: "data:image/png;base64,AAAA", statusCode: 200 },
      { url: "https://cloud.umami.is/script.js", statusCode: -1 },
      { url: "https://api.web3modal.org/appkit/v1/project-limits?projectId=0", statusCode: 200 },
    ],
  });
  expect(thirdPartyRequests(result)).toEqual([
    { url: "https://cloud.umami.is/script.js", blocked: true, status: -1 },
    { url: "https://api.web3modal.org/appkit/v1/project-limits", blocked: false, status: 200 },
  ]);
});

test("lighthouse-report › the summary shows each route's median, the version and the commit", () => {
  const home = "http://localhost:3000/";
  const entry = "http://localhost:3000/mainnet";
  const out = summarize(
    [
      { url: home, lhr: lhr({ score: 0.98, lcp: 2500, tbt: 20 }) },
      { url: home, lhr: lhr({ score: 0.92, lcp: 2700, tbt: 230 }) },
      { url: home, lhr: lhr({ score: 0.97, lcp: 2400, tbt: 16 }) },
      { url: entry, lhr: lhr({ requests: [{ url: "https://x.example/a", statusCode: -1 }] }) },
      { url: entry, lhr: { ...lhr(), categories: { performance: { score: null } } } },
    ],
    "0123abc"
  );
  expect(out).toContain("Lighthouse 13.6.0 at commit `0123abc`");
  expect(out).toContain("| `/` | 3 of 3 | 97 | 2500 ms | 0.000 | 20 ms | 300.0 KB |");
  expect(out).toContain("| `/mainnet` | 1 of 2 | 90 | 2000 ms | 0.000 | 50 ms | 300.0 KB |");
  expect(out).toContain("- blocked: https://x.example/a (from `/mainnet`)");
});

test("lighthouse-report › the summary says so when every request stayed local", () => {
  expect(summarize([{ url: "http://localhost:3000/", lhr: lhr() }], "c")).toContain(
    "None: every request went to the local server."
  );
});

test("lighthouse-report › the config measures the four routes on a fixed mobile profile and asserts nothing", () => {
  const config = JSON.parse(readFileSync(join(WEB_ROOT, "lighthouserc.json"), "utf8"));
  expect(Object.keys(config.ci).sort()).toEqual(["collect", "upload"]);
  const { collect } = config.ci;
  expect(collect.url.map((u: string) => new URL(u).pathname)).toEqual([
    "/",
    "/how-it-works",
    "/blog/how-do-i-remove-a-trustline-on-stellar",
    "/mainnet",
  ]);
  expect(collect.settings.formFactor).toBe("mobile");
  expect(collect.settings.throttlingMethod).toBe("simulate");
  expect(collect.settings.throttling).toEqual({
    rttMs: 150,
    throughputKbps: 1638.4,
    requestLatencyMs: 562.5,
    downloadThroughputKbps: 1474.56,
    uploadThroughputKbps: 675,
    cpuSlowdownMultiplier: 4,
  });
  expect(collect.settings.chromeFlags).toContain(
    '--host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE localhost"'
  );
});

test("lighthouse-report › the blog post the config measures exists", () => {
  expect(() =>
    readFileSync(
      join(WEB_ROOT, "content", "blog", "how-do-i-remove-a-trustline-on-stellar.mdx"),
      "utf8"
    )
  ).not.toThrow();
});
