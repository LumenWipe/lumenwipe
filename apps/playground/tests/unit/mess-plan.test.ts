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

const sha256 = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const OLD_SETUP_LABEL = "Fund demo account & spawn rogue issuers";

/** The demo's swap assets before they were renamed so they cannot pass for real stablecoins. */
const OLD_ASSET_NAMES: readonly (readonly [string, string])[] = [
  ["DEMOUSD", "USDC"],
  ["DEMOEUR", "EURC"],
];

/** A shape with every string the rename touched (step ids, labels, node ids, codes) put back. */
function withOldAssetNames<T>(shape: T): T {
  return JSON.parse(
    OLD_ASSET_NAMES.reduce(
      (json, [current, old]) => json.split(current).join(old),
      JSON.stringify(shape)
    )
  ) as T;
}

test("all 243 modes and custom configs build exactly what they built before the registry", () => {
  const shapes = allModes().map(([mode, custom]) => legacyShape(mode, custom));
  expect(shapes).toHaveLength(243);
  // The pre-registry plans with two intended changes: a plan with no throwaway issuer no longer
  // says it spawns them, and the swap assets are DEMOUSD and DEMOEUR. Putting the old label and
  // the old names back gives the old hash, below.
  expect(sha256(shapes)).toBe("fdf50575ba412bcc820cd92756abc5945eddec40f6bca984dd777151ce6f3990");
});

test("the DEMOUSD and DEMOEUR rename is the only change from the plans before it", () => {
  const shapes = allModes().map(([mode, custom]) => withOldAssetNames(legacyShape(mode, custom)));
  // The hash this test pinned before the rename, at 932d548.
  expect(sha256(shapes)).toBe("3556b52e6b6eeda4b4463eaf9f97ea9c645509052aa6690fb94d107d826b2bf0");
});

test("the SETUP label and the asset names are the only changes from the plans before the registry", () => {
  const relabelled = allModes().map(([mode, custom]) => {
    const shape = withOldAssetNames(legacyShape(mode, custom));
    return {
      ...shape,
      steps: shape.steps.map(([id, label, ...rest]) => [
        id,
        id === "SETUP" ? OLD_SETUP_LABEL : label,
        ...rest,
      ]),
    };
  });
  // sha256 of the same shape computed from getMessPlanForMode, getNeededEphemeralCodes,
  // getFundRareAssets, getMessCounts and estimateCustomDuration at 47a0e27, with each balance
  // update limited to nodes the plan docks: FUND_RARE used to name tl:RUGPULL even when only
  // AIRDROP1 was trusted, a no-op on a node that never existed.
  expect(sha256(relabelled)).toBe(
    "844674a5f66008224311f06083e62fde4d6c252616040991b489001f2808ade0"
  );
});

test("the SETUP step names throwaway issuers only when the plan has some", () => {
  for (const [mode, custom] of allModes()) {
    const plan = resolvePlan(selectionForMode(mode, custom));
    const setup = plan.steps.find((s) => s.id === "SETUP");
    expect(setup?.label).toBe(
      plan.ephemeralAssets.length > 0 ? OLD_SETUP_LABEL : "Fund demo account"
    );
  }
  expect(getMessPlanForMode("light")[0]?.label).toBe("Fund demo account");
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
  expect(legacyShape("full").ephemeral).toEqual(["AIRDROP1", "RUGPULL", "DEMOUSD", "DEMOEUR"]);
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
