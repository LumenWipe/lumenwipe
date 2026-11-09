// The four original size modes, kept as named selections of the scenario registry
// (lib/scenarios). Nothing here builds a plan of its own.
import { resolvePlan, type MessStepDef, type ScenarioSelection } from "./scenarios";

export type PlaygroundMode = "light" | "standard" | "full" | "custom";

export interface PlaygroundCustomConfig {
  /** 1-5: each level adds the next trustline (LWDEMO, AIRDROP1, RUGPULL, USDC, EURC). */
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

export interface PlaygroundModeConfig {
  mode: PlaygroundMode;
  label: string;
  description: string;
}

export const PLAYGROUND_MODE_CONFIGS: PlaygroundModeConfig[] = [
  { mode: "light", label: "Light", description: "1 trustline · signs 3×" },
  {
    mode: "standard",
    label: "Standard",
    description: "3 trustlines · offers · data entries · signer",
  },
  { mode: "full", label: "Full", description: "5 trustlines (USDC & EURC) · all categories" },
  { mode: "custom", label: "Custom", description: "Configure each category" },
];

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

const STANDARD: ScenarioSelection = {
  scenarios: [
    { id: "lwdemo-holding", params: {} },
    { id: "junk-airdrops", params: { tokens: 2 } },
    { id: "data-entries", params: { count: 3 } },
    { id: "stale-offers", params: { count: 3 } },
    { id: "forgotten-signer", params: {} },
  ],
};

const FULL: ScenarioSelection = {
  scenarios: [
    { id: "lwdemo-holding", params: {} },
    { id: "junk-airdrops", params: { tokens: 2 } },
    { id: "stablecoin-swaps", params: { tokens: 2 } },
    { id: "data-entries", params: { count: 3 } },
    { id: "stale-offers", params: { count: 5 } },
    { id: "forgotten-signer", params: {} },
  ],
};

export function selectionForMode(
  mode: PlaygroundMode,
  custom: PlaygroundCustomConfig = DEFAULT_CUSTOM_CONFIG
): ScenarioSelection {
  if (mode === "light") return { scenarios: [{ id: "lwdemo-holding", params: {} }] };
  if (mode === "standard") return STANDARD;
  if (mode === "full") return FULL;
  return customSelection(custom);
}

export function getMessPlanForMode(
  mode: PlaygroundMode,
  custom?: PlaygroundCustomConfig
): MessStepDef[] {
  return resolvePlan(selectionForMode(mode, custom)).steps;
}

/** Estimated end-to-end seconds for a mode, from the registry's cost model. */
export function estimateSeconds(mode: PlaygroundMode, custom?: PlaygroundCustomConfig): number {
  return resolvePlan(selectionForMode(mode, custom)).cost.seconds;
}
