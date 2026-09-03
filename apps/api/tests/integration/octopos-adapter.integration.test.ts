import { test, expect } from "bun:test";
import { fetchOctoPosPortfolio } from "@/lib/defi-positions/octopos-http";
import { normalizeOctoPosPortfolio } from "@/lib/defi-positions/octopos-adapter";

// This test calls the real, live OctoPos public mainnet endpoint - no API key, no mock. The
// package's `test` script scopes itself to tests/unit + tests/e2e, so a bare `bun test` never
// picks this up; only `bun run test:integration` sets the opt-in flag (see CLAUDE.md's warning
// about the bare-`bun test` footgun).
const RUN_INTEGRATION = !!process.env.LUMENWIPE_RUN_INTEGRATION;

const OCTOPOS_MAINNET_URL = "https://api-octopos-mainnet.untangled.finance";
// A real mainnet address confirmed (by manual curl during development of #146) to hold no
// DeFi positions - this is a canary for upstream contract drift, not a positions-parsing test.
const CLEAN_ADDRESS = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";

test.skipIf(!RUN_INTEGRATION)(
  "the live OctoPos portfolio shape still normalizes without throwing",
  async () => {
    const result = await fetchOctoPosPortfolio(CLEAN_ADDRESS, { baseUrl: OCTOPOS_MAINNET_URL });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const normalized = normalizeOctoPosPortfolio(result.raw, CLEAN_ADDRESS, "mainnet");
    expect(normalized.address).toBe(CLEAN_ADDRESS);
    expect(Array.isArray(normalized.positions)).toBe(true);
    expect(Array.isArray(normalized.unrecognizedPositions)).toBe(true);
    expect(typeof normalized.source).toBe("string");
  },
  15_000
);
