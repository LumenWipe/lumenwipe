import { test, expect } from "bun:test";
import { normalizeOctoPosPortfolio } from "@/lib/defi-positions/octopos-adapter";
import emptyPortfolio from "./fixtures/octopos/empty-portfolio.json";
import populatedPortfolio from "./fixtures/octopos/populated-portfolio.json";

const ADDRESS = emptyPortfolio.address;

// ─── the real, captured "no positions" case ─────────────────────────────────

test("maps a real captured empty portfolio to a clean result", () => {
  const result = normalizeOctoPosPortfolio(emptyPortfolio, ADDRESS, "mainnet");
  expect(result.address).toBe(ADDRESS);
  expect(result.network).toBe("mainnet");
  expect(result.positions).toEqual([]);
  expect(result.unrecognizedPositions).toEqual([]);
  expect(result.source).toBe("not-tracked");
  expect(result.timestamp).toBeNull();
});

test("builds the enrichment map from queryKeys.tokenInfos on the empty portfolio", () => {
  const result = normalizeOctoPosPortfolio(emptyPortfolio, ADDRESS, "mainnet");
  const xlm = result.enrichment["CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA"];
  expect(xlm).toEqual({ symbol: "XLM", decimals: 7, usdPrice: null, priceSource: null });
});

test("carries the supported-protocol query key slices through, typed", () => {
  const result = normalizeOctoPosPortfolio(emptyPortfolio, ADDRESS, "mainnet");
  expect(Object.keys(result.queryKeys.slices).sort()).toEqual(
    ["aquarius", "blend", "fxdao", "phoenix", "soroswap"].sort()
  );
});

// ─── the populated case ──────────────────────────────────────────────────────

test("maps each supported protocol's position type", () => {
  const result = normalizeOctoPosPortfolio(
    populatedPortfolio,
    populatedPortfolio.address,
    "mainnet"
  );
  const byKey = new Map(result.positions.map((p) => [`${p.protocol}:${p.positionType}`, p]));

  expect(byKey.get("blend:supply")).toMatchObject({
    protocol: "blend",
    positionType: "supply",
    assetAddress: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
    bTokenAmount: "500000000",
    usdValue: "50.12",
  });
  expect(byKey.get("blend:borrow")).toMatchObject({
    protocol: "blend",
    positionType: "borrow",
    dTokenAmount: "100000000",
    healthFactor: "1.85",
  });
  expect(byKey.get("aquarius:lp")).toMatchObject({
    protocol: "aquarius",
    positionType: "lp",
    shareAmount: "1000000",
    claimableAquaAmount: "250000",
  });
  expect(byKey.get("soroswap:lp")).toMatchObject({
    protocol: "soroswap",
    positionType: "lp",
    shareAmount: "2000000",
  });
  expect(byKey.get("phoenix:lp")).toMatchObject({
    protocol: "phoenix",
    positionType: "lp",
    shareAmount: "3000000",
  });
  expect(byKey.get("phoenix:stake")).toMatchObject({
    protocol: "phoenix",
    positionType: "stake",
    stakedAmount: "500000",
    stakedAtEpoch: "1750000000",
  });
});

test("merges fxdao's separate COLLATERAL and BORROW legs into one cdp position", () => {
  const result = normalizeOctoPosPortfolio(
    populatedPortfolio,
    populatedPortfolio.address,
    "mainnet"
  );
  const cdp = result.positions.find((p) => p.protocol === "fxdao");
  expect(cdp).toMatchObject({
    protocol: "fxdao",
    positionType: "cdp",
    denomination: "USD",
    collateralAmount: "10000000000",
    debtAmount: "700000000",
  });
});

test("drops a position from a protocol outside LumenWipe's supported list", () => {
  const result = normalizeOctoPosPortfolio(
    populatedPortfolio,
    populatedPortfolio.address,
    "mainnet"
  );
  const protocols = result.positions.map((p) => p.protocol);
  expect(protocols).not.toContain("untangled-vault");
  const unrecognizedProtocols = result.unrecognizedPositions.map((p) => p.protocol);
  expect(unrecognizedProtocols).not.toContain("untangled-vault" as never);
});

test("flags a malformed supported-protocol position instead of dropping or crashing", () => {
  const result = normalizeOctoPosPortfolio(
    populatedPortfolio,
    populatedPortfolio.address,
    "mainnet"
  );
  // The fixture's last blend SUPPLY entry is missing assetAddress/bTokenAmount/usdValue.
  const flagged = result.unrecognizedPositions.find(
    (p) => p.protocol === "blend" && p.rawType === "SUPPLY"
  );
  expect(flagged).toBeDefined();
  expect(flagged?.reason).toEqual(expect.any(String));
});

test("does not double-count the malformed position as a recognized supply position", () => {
  const result = normalizeOctoPosPortfolio(
    populatedPortfolio,
    populatedPortfolio.address,
    "mainnet"
  );
  const supplyPositions = result.positions.filter(
    (p) => p.protocol === "blend" && p.positionType === "supply"
  );
  expect(supplyPositions).toHaveLength(1);
});

// ─── malformed top-level responses ──────────────────────────────────────────

test("throws on a body that isn't recognizably a Portfolio at all", () => {
  expect(() => normalizeOctoPosPortfolio({ nonsense: true }, ADDRESS, "mainnet")).toThrow();
  expect(() => normalizeOctoPosPortfolio(null, ADDRESS, "mainnet")).toThrow();
});
