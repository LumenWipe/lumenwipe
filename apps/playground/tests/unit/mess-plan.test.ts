import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import {
  DEFAULT_CUSTOM_CONFIG,
  getMessPlanForMode,
  maxOfferCount,
  selectionForMode,
  type PlaygroundCustomConfig,
  type PlaygroundMode,
} from "@/lib/mess-plan";
import { isMessStepId, resolvePlan } from "@/lib/scenarios";

// The four original modes are named selections of the scenario registry. These tests hold them to
// what they built before the registry existed.

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

const allModes = (): [PlaygroundMode, PlaygroundCustomConfig | undefined][] => [
  ["light", undefined],
  ["standard", undefined],
  ["full", undefined],
  ...[...customConfigs()].map((c): ["custom", PlaygroundCustomConfig] => ["custom", c]),
];

/** Every observable output of a mode, in the shape the pre-registry functions returned it. */
function legacyShape(mode: PlaygroundMode, custom?: PlaygroundCustomConfig) {
  const plan = resolvePlan(selectionForMode(mode, custom));
  const rare = plan.steps.find((s) => s.id === "FUND_RARE")?.action;
  return {
    steps: plan.steps.map((s) => [
      s.id,
      s.label,
      s.nodes.map((n) => n.id),
      s.balances.map((b) => b.nodeId),
    ]),
    ephemeral: plan.ephemeralAssets,
    rare: rare?.kind === "airdrops" ? rare.payments.map((p) => p.asset) : [],
    counts: { offerCount: plan.expectation.offers, dataEntryCount: plan.expectation.dataEntries },
    seconds: mode === "custom" ? plan.cost.seconds : null,
  };
}

test("all 243 modes and custom configs build exactly what they built before the registry", () => {
  const shapes = allModes().map(([mode, custom]) => legacyShape(mode, custom));
  expect(shapes).toHaveLength(243);
  // sha256 of the same shape computed from getMessPlanForMode, getNeededEphemeralCodes,
  // getFundRareAssets, getMessCounts and estimateCustomDuration at 47a0e27, with each balance
  // update limited to nodes the plan docks: FUND_RARE used to name tl:RUGPULL even when only
  // AIRDROP1 was trusted, a no-op on a node that never existed.
  expect(createHash("sha256").update(JSON.stringify(shapes)).digest("hex")).toBe(
    "844674a5f66008224311f06083e62fde4d6c252616040991b489001f2808ade0"
  );
});

test("light, standard and full keep their step order and counts", () => {
  expect(getMessPlanForMode("light").map((s) => s.id)).toEqual([
    "SETUP",
    "TRUST_LWDEMO",
    "FUND_LWDEMO",
  ]);
  expect(getMessPlanForMode("standard").map((s) => s.id)).toEqual([
    "SETUP",
    "TRUST_AIRDROP1",
    "TRUST_RUGPULL",
    "TRUST_LWDEMO",
    "FUND_RARE",
    "FUND_LWDEMO",
    "DATA_ENTRIES",
    "OFFERS",
    "ADD_SIGNER",
  ]);
  expect(legacyShape("standard").counts).toEqual({ offerCount: 3, dataEntryCount: 3 });
  expect(legacyShape("full").counts).toEqual({ offerCount: 5, dataEntryCount: 3 });
  expect(legacyShape("full").ephemeral).toEqual(["AIRDROP1", "RUGPULL", "USDC", "EURC"]);
});

test("every mode and custom config is a valid selection", () => {
  for (const [mode, custom] of allModes()) {
    expect(() => resolvePlan(selectionForMode(mode, custom))).not.toThrow();
  }
});

test("the duration estimate is pinned at the smallest, default and largest custom demos", () => {
  const smallest = { trustlineCount: 1, offerCount: 0, dataEntryCount: 0, addSigner: false };
  const largest = { trustlineCount: 5, offerCount: 5, dataEntryCount: 5, addSigner: true };
  const seconds = (mode: PlaygroundMode, custom?: PlaygroundCustomConfig): number =>
    resolvePlan(selectionForMode(mode, custom)).cost.seconds;
  expect(seconds("custom", smallest)).toBe(39);
  expect(seconds("custom", DEFAULT_CUSTOM_CONFIG)).toBe(83);
  expect(seconds("custom", largest)).toBe(145);
  expect(seconds("light")).toBe(39);
});

test("maxOfferCount is capped by both trustlineCount and the junk-offer catalog", () => {
  expect(maxOfferCount(2)).toBe(2);
  expect(maxOfferCount(10)).toBe(5);
});

test("isMessStepId recognizes known step ids and rejects unknown ones", () => {
  expect(isMessStepId("SETUP")).toBe(true);
  expect(isMessStepId("DATA_ENTRIES")).toBe(true);
  expect(isMessStepId("NOT_A_STEP")).toBe(false);
  expect(isMessStepId("setup")).toBe(false);
});
