import { test, expect } from "bun:test";
import { assessDefiPositionsGate } from "@/lib/defi-positions/positions-gate";
import {
  DEGRADED_SOURCE,
  DEGRADED_SOURCE_CONFIRMED,
} from "@/lib/defi-positions/resolve-defi-positions";
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

// ─── confirmed-empty via direct read, on a zero-trustline account ───────────
//
// A classic AMM LP position always requires a trustline, so an account with zero of them plus
// a direct on-chain sweep that found nothing is a materially different situation from "we
// genuinely have no idea" - it gets a distinct, non-trapping code rather than the hard blocker.

test("a confirmed-empty degraded result on a zero-trustline account gets the softer code", () => {
  const result = makeResult({ source: DEGRADED_SOURCE_CONFIRMED, timestamp: null });
  const blockers = assessDefiPositionsGate(result, new Date(), 0);
  expect(blockers).toHaveLength(1);
  expect(blockers[0].code).toBe("defi_positions_unconfirmed_no_trustlines");
});

test("the same confirmed-empty result still hard-blocks when the account has trustlines", () => {
  const result = makeResult({ source: DEGRADED_SOURCE_CONFIRMED, timestamp: null });
  const blockers = assessDefiPositionsGate(result, new Date(), 3);
  expect(blockers).toHaveLength(1);
  expect(blockers[0].code).toBe("defi_positions_unavailable");
});

test("an unknown trustline count (caller not updated yet) still hard-blocks - fails closed", () => {
  const result = makeResult({ source: DEGRADED_SOURCE_CONFIRMED, timestamp: null });
  const blockers = assessDefiPositionsGate(result);
  expect(blockers).toHaveLength(1);
  expect(blockers[0].code).toBe("defi_positions_unavailable");
});

// ─── confirmed sweep that actually found a real position ────────────────────
//
// A regression from a real mainnet account: OctoPos was down, the direct-read sweep completed
// and found a genuine, fully-recognized Blend supply position, and the account was still hard-
// blocked with "may hold open DeFi positions that have not been detected" - a message actively
// contradicted by the account already showing that exact detected position. Finding something
// concrete via a code-hash-verified on-chain read is a stronger confirmation than finding
// nothing, not a weaker one, so it must not be treated worse than the confirmed-empty case.

const BLEND_POSITION = {
  protocol: "blend" as const,
  positionType: "supply" as const,
  contractAddress: "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD",
  assetAddress: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
  bTokenAmount: "99997766",
  usdValue: null,
};

test("a confirmed sweep that found a real, fully-recognized position does not hard-block", () => {
  const result = makeResult({
    source: DEGRADED_SOURCE_CONFIRMED,
    timestamp: null,
    positions: [BLEND_POSITION],
  });
  const blockers = assessDefiPositionsGate(result, new Date(), 0);
  expect(blockers).toHaveLength(1);
  expect(blockers[0].code).toBe("defi_positions_unconfirmed_but_detected");
});

test("the detected-position code does not depend on trustline count, unlike the empty case", () => {
  const result = makeResult({
    source: DEGRADED_SOURCE_CONFIRMED,
    timestamp: null,
    positions: [BLEND_POSITION],
  });
  // 5 trustlines - the AMM-ruling-out heuristic for the empty case is irrelevant here, since
  // the account already has a named, concrete position to act on regardless of trustline count.
  const blockers = assessDefiPositionsGate(result, new Date(), 5);
  expect(blockers).toHaveLength(1);
  expect(blockers[0].code).toBe("defi_positions_unconfirmed_but_detected");
});

test("a genuinely unconfirmed result with positions (sweep itself never ran) still hard-blocks", () => {
  // DEGRADED_SOURCE with non-empty positions cannot happen from resolveDefiPositions today (the
  // failure branch always reports empty), but the gate must not derive "detected and actionable"
  // from positions content alone - only a confirmed source makes that claim trustworthy.
  const result = makeResult({
    source: DEGRADED_SOURCE,
    timestamp: null,
    positions: [BLEND_POSITION],
  });
  const blockers = assessDefiPositionsGate(result, new Date(), 0);
  expect(blockers).toHaveLength(1);
  expect(blockers[0].code).toBe("defi_positions_unavailable");
});

test("a genuinely unconfirmed degraded result (direct read also failed) still hard-blocks even with zero trustlines", () => {
  const result = makeResult({ source: DEGRADED_SOURCE, timestamp: null });
  const blockers = assessDefiPositionsGate(result, new Date(), 0);
  expect(blockers).toHaveLength(1);
  expect(blockers[0].code).toBe("defi_positions_unavailable");
});
