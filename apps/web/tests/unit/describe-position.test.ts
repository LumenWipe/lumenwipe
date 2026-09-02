import { expect, test } from "bun:test";
import type { DefiPosition } from "@/types/account";
import {
  describeDefiPosition,
  formatPositionAmount,
  positionContracts,
} from "@/lib/plan/describe-position";

const POOL = "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF";
const XLM_SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const XLM = { symbol: "XLM", decimals: 7, usdPrice: null, priceSource: null };

const supply: DefiPosition = {
  protocol: "blend",
  positionType: "supply",
  contractAddress: POOL,
  assetAddress: XLM_SAC,
  bTokenAmount: "99000000",
  usdValue: null,
};

test("names the asset from the enrichment map, and falls back to a short contract id without it", () => {
  expect(describeDefiPosition(supply, { [XLM_SAC]: XLM })).toBe("Blend supply · XLM");
  expect(describeDefiPosition(supply, {})).toBe(
    `Blend supply · ${XLM_SAC.slice(0, 8)}…${XLM_SAC.slice(-8)}`
  );
});

test("a backstop deposit says so, and a borrow is a borrow", () => {
  expect(describeDefiPosition({ ...supply, isBackstop: true }, {})).toContain("(backstop)");
  const borrow: DefiPosition = {
    protocol: "blend",
    positionType: "borrow",
    contractAddress: POOL,
    assetAddress: XLM_SAC,
    dTokenAmount: "1",
    usdValue: null,
  };
  expect(describeDefiPosition(borrow, { [XLM_SAC]: XLM })).toBe("Blend borrow · XLM");
});

test("LP, stake, and vault positions each read as what they are", () => {
  const lp: DefiPosition = {
    protocol: "soroswap",
    positionType: "lp",
    contractAddress: POOL,
    shareAmount: "42",
    usdValue: null,
  };
  const stake: DefiPosition = {
    protocol: "phoenix",
    positionType: "stake",
    contractAddress: POOL,
    stakedAmount: "7",
    stakedAtEpoch: "1700000000",
    usdValue: null,
  };
  const cdp: DefiPosition = {
    protocol: "fxdao",
    positionType: "cdp",
    contractAddress: POOL,
    denomination: "USD",
    collateralAmount: "100",
    debtAmount: "40",
    usdValue: null,
  };
  expect(describeDefiPosition(lp, {})).toBe("Soroswap LP position · 42 shares");
  expect(describeDefiPosition(stake, {})).toBe("Phoenix stake · 7");
  expect(describeDefiPosition(cdp, {})).toBe("FxDAO vault · USD · collateral 100, debt 40");
});

test("positionContracts lists each pool once, in first-seen order", () => {
  const other = {
    ...supply,
    contractAddress: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
  };
  expect(positionContracts([supply, other, supply])).toEqual([POOL, other.contractAddress]);
});

test("with display data it reads the way the protocol's own UI would", () => {
  const shown: DefiPosition = {
    ...supply,
    display: {
      pool: "Comet",
      asset: "XLM",
      amount: "10.0100015",
      collateralAmount: "2",
      yieldPct: "3.99",
      yieldKind: "earned",
    },
  };
  expect(describeDefiPosition(shown, {})).toBe(
    "Blend · Comet · Supply · 10.0100015 XLM (2.00 as collateral) · 3.99% APY"
  );
  const debt: DefiPosition = {
    protocol: "blend",
    positionType: "borrow",
    contractAddress: POOL,
    assetAddress: XLM_SAC,
    dTokenAmount: "1",
    usdValue: null,
    display: {
      pool: null,
      asset: "USDC",
      amount: "1000",
      collateralAmount: null,
      yieldPct: "5.50",
      yieldKind: "paid",
    },
  };
  expect(describeDefiPosition(debt, {})).toBe(
    `Blend · ${POOL.slice(0, 8)}…${POOL.slice(-8)} · Borrow · 1,000.00 USDC · 5.50% APY paid`
  );
});

test("display gaps degrade one field at a time, never to a wrong number", () => {
  const partial: DefiPosition = {
    ...supply,
    isBackstop: true,
    display: {
      pool: "Comet",
      asset: null,
      amount: null,
      collateralAmount: null,
      yieldPct: null,
      yieldKind: null,
    },
  };
  expect(describeDefiPosition(partial, {})).toBe("Blend · Comet · Backstop deposit");
});

test("formatPositionAmount keeps up to seven decimals, at least two, with thousands separators", () => {
  expect(formatPositionAmount("10")).toBe("10.00");
  expect(formatPositionAmount("10.0100015")).toBe("10.0100015");
  expect(formatPositionAmount("1234567.5")).toBe("1,234,567.50");
  expect(formatPositionAmount("0.00000001")).toBe("0.00");
});
