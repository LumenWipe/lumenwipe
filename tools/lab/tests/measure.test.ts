import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutRoot } from "../src/home";
import { measure, type TargetSession } from "../src/measure";
import { assertNoSecrets, renderReport, writeResults } from "../src/report";
import { scenariosFor } from "../src/scenarios";
import type { Span } from "../src/spans";

const SENTINEL_KEY = `lw_${"Q".repeat(43)}`;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fakeApi(status: (path: string) => number) {
  const seen: { url: string; authorization: string | null }[] = [];
  const spans: Span[] = [];
  let clock = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({ url, authorization: headers.get("Authorization") });
    spans.push({ label: "rpc:getLedgerEntries", start: clock, end: clock + 50 });
    clock += seen.length === 1 ? 900 : 100;
    return new Response(`{"echo":"${headers.get("Authorization")}"}`, {
      status: status(new URL(url).pathname),
    });
  }) as unknown as typeof fetch;
  return { seen, spans, fetchImpl, now: () => clock };
}

const scenarios = scenariosFor("testnet").filter((s) =>
  ["health", "analyze-dense", "plan"].includes(s.id)
);

describe("measure", () => {
  test("sends the key as a bearer header and reports cold and warm separately", async () => {
    const api = fakeApi(() => 200);
    let opened = 0;
    const results = await measure({
      target: "production",
      scenarios: scenarios.slice(0, 1),
      runs: 5,
      rounds: 1,
      open: async () => {
        opened += 1;
        return { baseUrl: "http://127.0.0.1:1", apiKey: SENTINEL_KEY, stop: async () => {} };
      },
      fetchImpl: api.fetchImpl,
      now: api.now,
      pause: async () => {},
    });
    expect(opened).toBe(1);
    expect(api.seen).toHaveLength(5);
    expect(api.seen.every((r) => r.authorization === `Bearer ${SENTINEL_KEY}`)).toBe(true);
    expect(results[0].statuses).toEqual({ "200": 5 });
    expect(results[0].warm.n).toBe(4);
  });

  test("opens a fresh session per round and keeps the warm span breakdown", async () => {
    const api = fakeApi(() => 200);
    const sessions: TargetSession[] = [];
    const results = await measure({
      target: "local",
      scenarios: scenarios.slice(0, 1),
      runs: 5,
      rounds: 2,
      open: async () => {
        const s = {
          baseUrl: "http://127.0.0.1:1",
          apiKey: "local",
          bootMs: 500,
          spans: () => api.spans,
          stop: async () => {},
        };
        sessions.push(s);
        return s;
      },
      fetchImpl: api.fetchImpl,
      now: api.now,
      pause: async () => {},
    });
    expect(sessions).toHaveLength(2);
    expect(results[0].cold.n).toBe(2);
    expect(results[0].boot).toEqual({ n: 2, p50: 500, p95: 500 });
    expect(results[0].spans).toEqual({
      upstreams: { "rpc:getLedgerEntries": { calls: 1, ms: 50 } },
      upstreamMs: 50,
      ownMs: 50,
    });
  });

  test("reports a fixture that is gone as missing instead of measuring 404s", async () => {
    const api = fakeApi((path) => (path.includes("/account/") ? 404 : 200));
    const results = await measure({
      target: "production",
      scenarios: scenarios.filter((s) => s.id === "analyze-dense"),
      runs: 5,
      rounds: 3,
      open: async () => ({ baseUrl: "http://127.0.0.1:1", apiKey: "k", stop: async () => {} }),
      fetchImpl: api.fetchImpl,
      now: api.now,
      pause: async () => {},
    });
    expect(api.seen).toHaveLength(1);
    expect(results[0].missing).toBe(true);
  });

  test("refuses fewer than 5 or more than 11 runs", async () => {
    for (const runs of [4, 12, 5.5]) {
      await expect(
        measure({
          target: "production",
          scenarios,
          runs,
          rounds: 1,
          open: async () => ({ baseUrl: "", apiKey: "", stop: async () => {} }),
        })
      ).rejects.toThrow(RangeError);
    }
  });
});

describe("what the lab writes", () => {
  test("never carries an Authorization header or a key, checked by reading every file back", async () => {
    const api = fakeApi(() => 200);
    const results = await measure({
      target: "production",
      scenarios,
      runs: 5,
      rounds: 1,
      open: async () => ({
        baseUrl: "http://127.0.0.1:1",
        apiKey: SENTINEL_KEY,
        stop: async () => {},
      }),
      fetchImpl: api.fetchImpl,
      now: api.now,
      pause: async () => {},
    });
    const dir = mkdtempSync(join(tmpdir(), "lab-results-test-"));
    dirs.push(dir);
    const meta = { date: "2026-11-09T00:00:00.000Z", commit: "abc1234" };
    writeResults(
      dir,
      {
        "table.md": renderReport(meta, results),
        "results.json": JSON.stringify({ meta, results }),
      },
      [SENTINEL_KEY]
    );
    const files = readdirSync(dir);
    expect(files.sort()).toEqual(["results.json", "table.md"]);
    for (const file of files) {
      const text = readFileSync(join(dir, file), "utf8");
      expect(text).not.toMatch(/authorization/i);
      expect(text).not.toMatch(/bearer/i);
      expect(text).not.toContain(SENTINEL_KEY);
      expect(text).not.toMatch(/\blw_[A-Za-z0-9_-]{43}/);
      expect(text).not.toMatch(/\bS[A-Z2-7]{55}\b/);
    }
  });

  test("refuses to write text that carries a header, a key shape or a known secret", () => {
    const secretShaped = `S${"A".repeat(55)}`;
    for (const text of [
      "Authorization: x",
      "bearer abc",
      `key ${SENTINEL_KEY}`,
      `lab_${"b".repeat(32)}`,
      secretShaped,
      "plain but known-secret",
    ]) {
      expect(() => assertNoSecrets(text, ["known-secret"])).toThrow(/refusing/);
    }
    expect(() => assertNoSecrets("| local | testnet | 120 |", ["known-secret"])).not.toThrow();
  });

  test("writes nothing when any file would carry a secret", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "lab-results-test-")), "run");
    dirs.push(join(dir, ".."));
    expect(() =>
      writeResults(dir, { "table.md": "fine", "results.json": `{"k":"${SENTINEL_KEY}"}` }, [
        SENTINEL_KEY,
      ])
    ).toThrow(/refusing/);
    expect(existsSync(dir)).toBe(false);
  });

  test("refuses a results folder inside the checkout", () => {
    expect(() => writeResults(join(checkoutRoot(), "tools", "lab", "results"), {}, [])).toThrow(
      /outside the repository checkout/
    );
  });
});
