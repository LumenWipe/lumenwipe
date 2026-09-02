import { expect, test } from "bun:test";
import type { DefiPosition } from "@/types/account";
import { describeDefiPosition, positionContracts } from "@/lib/plan/describe-position";

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
