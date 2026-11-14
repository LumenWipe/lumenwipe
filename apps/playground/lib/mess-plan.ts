// The four original size modes, kept as named selections of the scenario registry
// (lib/scenarios). Nothing here builds a plan of its own.
import {
  FULL_SELECTION,
  LIGHT_SELECTION,
  STANDARD_SELECTION,
  resolvePlan,
  type MessStepDef,
  type ScenarioSelection,
} from "./scenarios";

export type PlaygroundMode = "light" | "standard" | "full" | "custom";

export interface PlaygroundCustomConfig {
  /** 1-5: each level adds the next trustline (LWDEMO, AIRDROP1, RUGPULL, DEMOUSD, DEMOEUR). */
  trustlineCount: number;
  /** 0 up to trustlineCount: each offer trades the token of the trustline at its level. */
  offerCount: number;
  /** 0-5 */
  dataEntryCount: number;
  addSigner: boolean;
}

export const DEFAULT_CUSTOM_CONFIG: PlaygroundCustomConfig = {
  trustlineCount: 2,
  offerCount: 2,
  dataEntryCount: 2,
  addSigner: false,
};

export const MAX_CUSTOM_TRUSTLINES = 5;
export const MAX_CUSTOM_DATA_ENTRIES = 5;

/** A custom config never offers more than its trustlines can trade. */
export function maxOfferCount(trustlineCount: number): number {
  return Math.min(trustlineCount, MAX_CUSTOM_TRUSTLINES);
}

function customSelection(c: PlaygroundCustomConfig): ScenarioSelection {
  const scenarios: ScenarioSelection["scenarios"] = [{ id: "lwdemo-holding", params: {} }];
  if (c.trustlineCount >= 2) {
    scenarios.push({ id: "junk-airdrops", params: { tokens: Math.min(c.trustlineCount - 1, 2) } });
  }
  if (c.trustlineCount >= 4) {
    scenarios.push({ id: "stablecoin-swaps", params: { tokens: c.trustlineCount - 3 } });
  }
  if (c.dataEntryCount > 0) {
    scenarios.push({ id: "data-entries", params: { count: c.dataEntryCount } });
  }
  if (c.offerCount > 0) scenarios.push({ id: "stale-offers", params: { count: c.offerCount } });
  if (c.addSigner) scenarios.push({ id: "forgotten-signer", params: {} });
  return { scenarios };
}

export function selectionForMode(
  mode: PlaygroundMode,
  custom: PlaygroundCustomConfig = DEFAULT_CUSTOM_CONFIG
): ScenarioSelection {
  if (mode === "light") return LIGHT_SELECTION;
  if (mode === "standard") return STANDARD_SELECTION;
  if (mode === "full") return FULL_SELECTION;
  return customSelection(custom);
}

export function getMessPlanForMode(
  mode: PlaygroundMode,
  custom?: PlaygroundCustomConfig
): MessStepDef[] {
  return resolvePlan(selectionForMode(mode, custom)).steps;
}
