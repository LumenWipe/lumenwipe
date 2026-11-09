import { test, expect } from "bun:test";
import {
  DEFAULT_CUSTOM_CONFIG,
  estimateCustomDuration,
  getFundRareAssets,
  getMessCounts,
  getMessPlanForMode,
  getNeededEphemeralCodes,
  maxOfferCount,
  isMessStepId,
  type PlaygroundCustomConfig,
} from "@/lib/mess-plan";

test("light mode is the shortest plan", () => {
  const plan = getMessPlanForMode("light");
  expect(plan.map((s) => s.id)).toEqual(["SETUP", "TRUST_LWDEMO", "FUND_LWDEMO"]);
});

test("full mode needs all four ephemeral assets", () => {
  expect(getNeededEphemeralCodes("full")).toEqual(["AIRDROP1", "RUGPULL", "USDC", "EURC"]);
});

test("custom mode respects trustlineCount for ephemeral codes", () => {
  expect(
    getNeededEphemeralCodes("custom", {
      trustlineCount: 3,
      offerCount: 0,
      dataEntryCount: 0,
      addSigner: false,
    })
  ).toEqual(["AIRDROP1", "RUGPULL"]);
});

test("maxOfferCount is capped by both trustlineCount and the junk-offer catalog", () => {
  expect(maxOfferCount(2)).toBe(2);
  expect(maxOfferCount(10)).toBe(5); // JUNK_OFFERS.length
});

test("isMessStepId recognizes known step ids and rejects unknown ones", () => {
  expect(isMessStepId("SETUP")).toBe(true);
  expect(isMessStepId("DATA_ENTRIES")).toBe(true);
  expect(isMessStepId("NOT_A_STEP")).toBe(false);
});

function* customConfigs(): Generator<PlaygroundCustomConfig> {
  for (let trustlineCount = 1; trustlineCount <= 5; trustlineCount++) {
    for (let offerCount = 0; offerCount <= maxOfferCount(trustlineCount); offerCount++) {
      for (let dataEntryCount = 0; dataEntryCount <= 5; dataEntryCount++) {
        for (const addSigner of [false, true]) {
          yield { trustlineCount, offerCount, dataEntryCount, addSigner };
        }
      }
    }
  }
}

test("each fixed mode posts its documented offer and data entry counts", () => {
  expect(getMessCounts("light")).toEqual({ offerCount: 0, dataEntryCount: 0 });
  expect(getMessCounts("standard")).toEqual({ offerCount: 3, dataEntryCount: 3 });
  expect(getMessCounts("full")).toEqual({ offerCount: 5, dataEntryCount: 3 });
  expect(getMessCounts("custom", { ...DEFAULT_CUSTOM_CONFIG, offerCount: 1 })).toEqual({
    offerCount: 1,
    dataEntryCount: DEFAULT_CUSTOM_CONFIG.dataEntryCount,
  });
});

test("the duration estimate is pinned at the smallest, default and largest custom demos", () => {
  const smallest = { trustlineCount: 1, offerCount: 0, dataEntryCount: 0, addSigner: false };
  const largest = { trustlineCount: 5, offerCount: 5, dataEntryCount: 5, addSigner: true };
  expect(estimateCustomDuration(smallest)).toBe(39);
  expect(estimateCustomDuration(DEFAULT_CUSTOM_CONFIG)).toBe(83);
  expect(estimateCustomDuration(largest)).toBe(145);
});

test("the duration estimate spends five seconds per plan step and eight per close step", () => {
  for (const config of customConfigs()) {
    const messSeconds = getMessPlanForMode("custom", config).length * 5;
    const closeSeconds = estimateCustomDuration(config) - messSeconds;
    // The close always has at least the merge, one trustline and the trustline removal.
    expect(closeSeconds % 8).toBe(0);
    expect(closeSeconds).toBeGreaterThanOrEqual(3 * 8);
  }
});

test("adding anything to a custom demo never shortens the estimate", () => {
  for (const config of customConfigs()) {
    const base = estimateCustomDuration(config);
    if (config.trustlineCount < 5) {
      expect(
        estimateCustomDuration({ ...config, trustlineCount: config.trustlineCount + 1 })
      ).toBeGreaterThan(base);
    }
    if (config.offerCount < maxOfferCount(config.trustlineCount)) {
      expect(
        estimateCustomDuration({ ...config, offerCount: config.offerCount + 1 })
      ).toBeGreaterThanOrEqual(base);
    }
    if (config.dataEntryCount < 5) {
      expect(
        estimateCustomDuration({ ...config, dataEntryCount: config.dataEntryCount + 1 })
      ).toBeGreaterThanOrEqual(base);
    }
    if (!config.addSigner) {
      expect(estimateCustomDuration({ ...config, addSigner: true })).toBeGreaterThan(base);
    }
  }
});

test("the rare assets are the airdropped junk tokens each mode trusts", () => {
  expect(getFundRareAssets("light")).toEqual([]);
  expect(getFundRareAssets("standard")).toEqual(["AIRDROP1", "RUGPULL"]);
  expect(getFundRareAssets("full")).toEqual(["AIRDROP1", "RUGPULL"]);
  const custom = (trustlineCount: number) =>
    getFundRareAssets("custom", { ...DEFAULT_CUSTOM_CONFIG, trustlineCount });
  expect(custom(1)).toEqual([]);
  expect(custom(2)).toEqual(["AIRDROP1"]);
  expect(custom(3)).toEqual(["AIRDROP1", "RUGPULL"]);
  expect(custom(5)).toEqual(["AIRDROP1", "RUGPULL"]);
});

test("a rare asset always has an issuer and a trustline, and FUND_RARE runs only when there is one", () => {
  const cases: [Parameters<typeof getMessPlanForMode>[0], PlaygroundCustomConfig?][] = [
    ["light"],
    ["standard"],
    ["full"],
    ...[...customConfigs()].map((c): ["custom", PlaygroundCustomConfig] => ["custom", c]),
  ];
  for (const [mode, config] of cases) {
    const rare = getFundRareAssets(mode, config);
    const plan = getMessPlanForMode(mode, config).map((s): string => s.id);
    const needed = getNeededEphemeralCodes(mode, config);
    for (const code of rare) {
      expect(needed).toContain(code);
      expect(plan).toContain(`TRUST_${code}`);
    }
    expect(plan.includes("FUND_RARE")).toBe(rare.length > 0);
  }
});
