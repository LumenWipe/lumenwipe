import { test, expect } from "bun:test";
import { assessDefiPositionsGate } from "@/lib/defi-positions/positions-gate";
import type { DefiPositionsResult, DefiQueryKeys } from "@lumenwipe/types";

const ADDRESS = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";

const EMPTY_QUERY_KEYS: DefiQueryKeys = {
  rpcEndpoints: [],
  rpcPolicy: { maxKeysPerCall: 0, recommendedConcurrency: 0, backoffOn429Ms: [], timeoutMs: 0 },
  slices: {},
};

function makeResult(overrides: Partial<DefiPositionsResult> = {}): DefiPositionsResult {
  return {
    address: ADDRESS,
    network: "mainnet",
    positions: [],
    unrecognizedPositions: [],
    enrichment: {},
    source: "snapshot",
    timestamp: new Date().toISOString(),
    queryKeys: EMPTY_QUERY_KEYS,
    ...overrides,
  };
}

// ─── no timestamp: OctoPos never took a snapshot (the real "not-tracked" case) ──

test("a null timestamp is flagged as unavailable, not treated as a clean account", () => {
  const result = makeResult({ source: "not-tracked", timestamp: null });
  const blockers = assessDefiPositionsGate(result);
  expect(blockers).toHaveLength(1);
  expect(blockers[0]).toMatchObject({ code: "defi_positions_unavailable" });
  expect(blockers[0].helpUrl).toBe(`https://stellar.expert/explorer/public/account/${ADDRESS}`);
});

test("a malformed timestamp is treated the same as no timestamp, not a crash", () => {
  const result = makeResult({ timestamp: "not-a-real-date" });
  const blockers = assessDefiPositionsGate(result);
  expect(blockers).toHaveLength(1);
  expect(blockers[0].code).toBe("defi_positions_unavailable");
});

// A degraded-mode result (issue #149's resolveDefiPositions falling back from an OctoPos outage)
// deliberately carries a null timestamp even though the direct-read fallback ran successfully -
// this is the mechanism it relies on to surface the same "verify manually" warning without a
// second, dedicated blocker type.
test("a degraded-mode fallback result (null timestamp, non-not-tracked source) is flagged too", () => {
  const result = makeResult({ source: "octopos-degraded-fallback", timestamp: null });
  const blockers = assessDefiPositionsGate(result);
  expect(blockers).toHaveLength(1);
  expect(blockers[0].code).toBe("defi_positions_unavailable");
});

// ─── staleness ───────────────────────────────────────────────────────────────

test("a fresh timestamp within the threshold produces no blockers", () => {
  const now = new Date("2026-01-01T00:02:00.000Z");
  const result = makeResult({ timestamp: "2026-01-01T00:00:30.000Z" });
  expect(assessDefiPositionsGate(result, now)).toEqual([]);
});

test("a timestamp older than the threshold is flagged as stale", () => {
  const now = new Date("2026-01-01T00:10:00.000Z");
  const result = makeResult({ timestamp: "2026-01-01T00:00:00.000Z" }); // 600s old
  const blockers = assessDefiPositionsGate(result, now);
  expect(blockers).toHaveLength(1);
  expect(blockers[0].code).toBe("defi_positions_stale");
  expect(blockers[0].message).toMatch(/600/);
});

test("a timestamp exactly at the threshold does not block", () => {
  const now = new Date("2026-01-01T00:02:00.000Z");
  const result = makeResult({ timestamp: "2026-01-01T00:00:00.000Z" }); // exactly 120s
  expect(assessDefiPositionsGate(result, now)).toEqual([]);
});

// ─── unrecognized positions: flagged, never silently dropped ────────────────

test("each unrecognized position gets its own blocker naming the protocol", () => {
  const now = new Date("2026-01-01T00:00:10.000Z");
  const result = makeResult({
    timestamp: "2026-01-01T00:00:00.000Z",
    unrecognizedPositions: [
      { protocol: "blend", rawType: "SUPPLY", reason: "missing assetAddress" },
      { protocol: "fxdao", rawType: "COLLATERAL", reason: "missing vaultAddress" },
    ],
  });
  const blockers = assessDefiPositionsGate(result, now);
  expect(blockers).toHaveLength(2);
  expect(blockers.every((b) => b.code === "defi_position_unrecognized")).toBe(true);
  expect(blockers[0].message).toMatch(/blend/);
  expect(blockers[1].message).toMatch(/fxdao/);
});

// ─── the clean case ──────────────────────────────────────────────────────────

test("a fresh, fully-recognized result produces zero blockers", () => {
  const now = new Date("2026-01-01T00:00:10.000Z");
  const result = makeResult({ timestamp: "2026-01-01T00:00:00.000Z" });
  expect(assessDefiPositionsGate(result, now)).toEqual([]);
});

// ─── helpUrl uses the account's own network ─────────────────────────────────

test("helpUrl points at the testnet explorer for a testnet result", () => {
  const result = makeResult({ network: "testnet", timestamp: null });
  const blockers = assessDefiPositionsGate(result);
  expect(blockers[0].helpUrl).toBe(`https://stellar.expert/explorer/testnet/account/${ADDRESS}`);
});
