// Declarative definition of the playground "mess" sequence. Isomorphic: the
// server executes these steps (see mess-builders.ts) and the client uses the
// same definitions to drive the orbital scene, so animation and chain reality
// can never drift apart.

export const LWDEMO_CODE = "LWDEMO";

// Base ephemeral assets (standard mode).
export const EPHEMERAL_ASSETS = [
  { code: "AIRDROP1", amount: "1000000" },
  { code: "RUGPULL", amount: "13.37" },
] as const;

// Additional ephemeral assets for full mode and custom trustlineCount ≥ 4/5.
export const FULL_EXTRA_EPHEMERAL_ASSETS = [
  { code: "USDC", amount: "50" },
  { code: "EURC", amount: "20" },
] as const;

export const LWDEMO_AMOUNT = "25";
// Amounts acquired via DEX swap (demo spends XLM to get these tokens).
// Kept small so the swap costs ~2 XLM each and demo's 30 XLM covers both.
export const USDC_DEMO_AMOUNT = "10";
export const EURC_DEMO_AMOUNT = "10";
// XLM cost per DEX swap: price per token × amount (0.2 × 10 = 2 XLM each).
export const DEMO_SWAP_PRICE = "0.2";

// XLM the demo keeps after returning the friendbot excess to the market maker.
// Keeping it small makes the locked-reserve counter visually meaningful.
export const DEMO_KEEP_XLM = "30";
export const EPHEMERAL_ISSUER_FUNDING_XLM = "3";

// Up to 5 data entries; standard/full modes use the first 3.
export const JUNK_DATA_ENTRIES = [
  { key: "promo_code", value: "WELCOME2024" },
  { key: "legacy_app_state", value: "deprecated" },
  { key: "airdrop_claim", value: "pending" },
  { key: "referral_id", value: "REF-ABC123" },
  { key: "kyc_status", value: "unverified" },
] as const;

// Up to 5 junk offers ordered by trustline dependency so offer[i] requires the
// trustline for trustlineCount ≥ i+1.  Designed to never cross with the MM's
// sell-XLM/buy-LWDEMO offer.
export const JUNK_OFFERS = [
  { selling: "native", buying: LWDEMO_CODE, amount: "5", price: "2" }, // 0 – needs LWDEMO
  { selling: "AIRDROP1", buying: "native", amount: "500000", price: "0.0001" }, // 1 – needs AIRDROP1
  { selling: "RUGPULL", buying: "native", amount: "10", price: "42" }, // 2 – needs RUGPULL
  { selling: "USDC", buying: "native", amount: "8", price: "10" }, // 3 – needs USDC (≤ USDC_DEMO_AMOUNT=10)
  { selling: "EURC", buying: "native", amount: "8", price: "10" }, // 4 – needs EURC (≤ EURC_DEMO_AMOUNT=10)
] as const;

// ─── Step IDs ──────────────────────────────────────────────────────────────────

export type MessStepId =
  | "SETUP"
  | "TRUST_AIRDROP1"
  | "TRUST_RUGPULL"
  | "TRUST_LWDEMO"
  | "TRUST_USDC"
  | "TRUST_EURC"
  | "FUND_RARE"
  | "FUND_LWDEMO"
  | "FUND_USDC"
  | "FUND_EURC"
  | "DATA_ENTRIES"
  | "OFFERS"
  | "ADD_SIGNER";

export interface MessStepDef {
  id: MessStepId;
  label: string;
  /** Scene nodes that dock when this step's tx is confirmed. */
  nodeIds: string[];
  /** Already-docked nodes that change (e.g. receive balance) on confirm. */
  updatesNodeIds: string[];
}

// ─── Mode types ────────────────────────────────────────────────────────────────

export type PlaygroundMode = "light" | "standard" | "full" | "custom";

export interface PlaygroundCustomConfig {
  /** 1–5: each level unlocks the next trustline asset (LWDEMO, AIRDROP1, RUGPULL, USDC, EURC) */
  trustlineCount: number;
  /** 0–N, capped to trustlineCount (each offer[i] requires trustline i) */
  offerCount: number;
  /** 0–5 */
  dataEntryCount: number;
  addSigner: boolean;
}

export const DEFAULT_CUSTOM_CONFIG: PlaygroundCustomConfig = {
  trustlineCount: 2,
  offerCount: 2,
  dataEntryCount: 2,
  addSigner: false,
};

export interface PlaygroundModeConfig {
  mode: PlaygroundMode;
  label: string;
  description: string;
  /** Seconds; 0 means computed dynamically (custom mode only). */
  estimatedSeconds: number;
}

export const PLAYGROUND_MODE_CONFIGS: PlaygroundModeConfig[] = [
  {
    mode: "light",
    label: "Light",
    description: "1 trustline · signs 3×",
    estimatedSeconds: 60,
  },
  {
    mode: "standard",
    label: "Standard",
    description: "3 trustlines · offers · data entries · signer",
    estimatedSeconds: 150,
  },
  {
    mode: "full",
    label: "Full",
    description: "5 trustlines (USDC & EURC) · all categories",
    estimatedSeconds: 240,
  },
  {
    mode: "custom",
    label: "Custom",
    description: "Configure each category",
    estimatedSeconds: 0,
  },
];

// ─── Internal step builders ────────────────────────────────────────────────────

function buildOffersStep(count: number): MessStepDef {
  return {
    id: "OFFERS",
    label: `Post ${count} stale DEX offer${count !== 1 ? "s" : ""}`,
    nodeIds: Array.from({ length: count }, (_, i) => `offer:${i}`),
    updatesNodeIds: [],
  };
}

function buildDataEntriesStep(count: number): MessStepDef {
  return {
    id: "DATA_ENTRIES",
    label: `Attach ${count} leftover data entr${count !== 1 ? "ies" : "y"}`,
    nodeIds: JUNK_DATA_ENTRIES.slice(0, count).map((d) => `data:${d.key}`),
    updatesNodeIds: [],
  };
}

// Static step definitions (node IDs are fixed; counts are injected at build time).
const STEP: Partial<Record<MessStepId, MessStepDef>> = {
  SETUP: {
    id: "SETUP",
    label: "Fund demo account & spawn rogue issuers",
    nodeIds: [],
    updatesNodeIds: [],
  },
  TRUST_AIRDROP1: {
    id: "TRUST_AIRDROP1",
    label: "Open AIRDROP1 trustline",
    nodeIds: ["tl:AIRDROP1"],
    updatesNodeIds: [],
  },
  TRUST_RUGPULL: {
    id: "TRUST_RUGPULL",
    label: "Open RUGPULL trustline",
    nodeIds: ["tl:RUGPULL"],
    updatesNodeIds: [],
  },
  TRUST_LWDEMO: {
    id: "TRUST_LWDEMO",
    label: "Open LWDEMO trustline",
    nodeIds: ["tl:LWDEMO"],
    updatesNodeIds: [],
  },
  TRUST_USDC: {
    id: "TRUST_USDC",
    label: "Open USDC trustline",
    nodeIds: ["tl:USDC"],
    updatesNodeIds: [],
  },
  TRUST_EURC: {
    id: "TRUST_EURC",
    label: "Open EURC trustline",
    nodeIds: ["tl:EURC"],
    updatesNodeIds: [],
  },
  FUND_RARE: {
    id: "FUND_RARE",
    label: "Receive junk token airdrops",
    nodeIds: [],
    updatesNodeIds: ["tl:AIRDROP1", "tl:RUGPULL"],
  },
  FUND_LWDEMO: {
    id: "FUND_LWDEMO",
    label: `Receive ${LWDEMO_AMOUNT} LWDEMO`,
    nodeIds: [],
    updatesNodeIds: ["tl:LWDEMO"],
  },
  FUND_USDC: {
    id: "FUND_USDC",
    label: `Swap XLM → ${USDC_DEMO_AMOUNT} USDC on the DEX`,
    nodeIds: [],
    updatesNodeIds: ["tl:USDC"],
  },
  FUND_EURC: {
    id: "FUND_EURC",
    label: `Swap XLM → ${EURC_DEMO_AMOUNT} EURC on the DEX`,
    nodeIds: [],
    updatesNodeIds: ["tl:EURC"],
  },
  ADD_SIGNER: {
    id: "ADD_SIGNER",
    label: "Add a forgotten co-signer",
    nodeIds: ["signer:extra"],
    updatesNodeIds: [],
  },
};

function st(id: MessStepId): MessStepDef {
  const step = STEP[id];
  if (!step) throw new Error(`Step ${id} must be built dynamically`);
  return step;
}

// ─── Public API ────────────────────────────────────────────────────────────────

export function getMessPlanForMode(
  mode: PlaygroundMode,
  custom?: PlaygroundCustomConfig
): MessStepDef[] {
  if (mode === "light") {
    return [st("SETUP"), st("TRUST_LWDEMO"), st("FUND_LWDEMO")];
  }

  if (mode === "standard") {
    return [
      st("SETUP"),
      st("TRUST_AIRDROP1"),
      st("TRUST_RUGPULL"),
      st("TRUST_LWDEMO"),
      st("FUND_RARE"),
      st("FUND_LWDEMO"),
      buildDataEntriesStep(3),
      buildOffersStep(3),
      st("ADD_SIGNER"),
    ];
  }

  if (mode === "full") {
    return [
      st("SETUP"),
      st("TRUST_AIRDROP1"),
      st("TRUST_RUGPULL"),
      st("TRUST_LWDEMO"),
      st("TRUST_USDC"),
      st("TRUST_EURC"),
      st("FUND_RARE"),
      st("FUND_LWDEMO"),
      st("FUND_USDC"),
      st("FUND_EURC"),
      buildDataEntriesStep(3),
      buildOffersStep(5),
      st("ADD_SIGNER"),
    ];
  }

  // custom
  const c: PlaygroundCustomConfig = custom ?? DEFAULT_CUSTOM_CONFIG;
  const steps: MessStepDef[] = [st("SETUP")];

  // Trust steps (ephemeral assets first so FUND_RARE runs after all trust ops)
  if (c.trustlineCount >= 2) steps.push(st("TRUST_AIRDROP1"));
  if (c.trustlineCount >= 3) steps.push(st("TRUST_RUGPULL"));
  steps.push(st("TRUST_LWDEMO")); // always present (trustlineCount ≥ 1)
  if (c.trustlineCount >= 4) steps.push(st("TRUST_USDC"));
  if (c.trustlineCount >= 5) steps.push(st("TRUST_EURC"));

  // Funding
  if (c.trustlineCount >= 2) steps.push(st("FUND_RARE"));
  steps.push(st("FUND_LWDEMO"));
  if (c.trustlineCount >= 4) steps.push(st("FUND_USDC"));
  if (c.trustlineCount >= 5) steps.push(st("FUND_EURC"));

  if (c.dataEntryCount > 0) steps.push(buildDataEntriesStep(c.dataEntryCount));
  if (c.offerCount > 0) steps.push(buildOffersStep(c.offerCount));
  if (c.addSigner) steps.push(st("ADD_SIGNER"));

  return steps;
}

export function isMessStepId(value: string): value is MessStepId {
  return Object.keys(STEP).includes(value) || value === "DATA_ENTRIES" || value === "OFFERS";
}

/** Which ephemeral codes the session needs to create (LWDEMO is persistent). */
export function getNeededEphemeralCodes(
  mode: PlaygroundMode,
  custom?: PlaygroundCustomConfig
): string[] {
  if (mode === "light") return [];
  if (mode === "standard") return EPHEMERAL_ASSETS.map((e) => e.code);
  if (mode === "full")
    return [
      ...EPHEMERAL_ASSETS.map((e) => e.code),
      ...FULL_EXTRA_EPHEMERAL_ASSETS.map((e) => e.code),
    ];
  const c = custom ?? DEFAULT_CUSTOM_CONFIG;
  const codes: string[] = [];
  if (c.trustlineCount >= 2) codes.push("AIRDROP1");
  if (c.trustlineCount >= 3) codes.push("RUGPULL");
  if (c.trustlineCount >= 4) codes.push("USDC");
  if (c.trustlineCount >= 5) codes.push("EURC");
  return codes;
}

/** Which of the ephemeral assets get funded in the FUND_RARE step. */
export function getFundRareAssets(mode: PlaygroundMode, custom?: PlaygroundCustomConfig): string[] {
  if (mode === "light") return [];
  if (mode === "standard" || mode === "full") return EPHEMERAL_ASSETS.map((e) => e.code);
  const c = custom ?? DEFAULT_CUSTOM_CONFIG;
  const codes: string[] = [];
  if (c.trustlineCount >= 2) codes.push("AIRDROP1");
  if (c.trustlineCount >= 3) codes.push("RUGPULL");
  return codes;
}

/** Max allowed offerCount for a given trustlineCount. */
export function maxOfferCount(trustlineCount: number): number {
  return Math.min(trustlineCount, JUNK_OFFERS.length);
}

/** Rough end-to-end duration estimate for a custom config, in seconds. */
export function estimateCustomDuration(config: PlaygroundCustomConfig): number {
  const MESS_S = 5;
  const DEMOLISH_S = 8;

  let messSteps = 1 + config.trustlineCount; // SETUP + TRUST_* each
  if (config.trustlineCount >= 2) messSteps += 1; // FUND_RARE
  messSteps += 1; // FUND_LWDEMO
  if (config.trustlineCount >= 4) messSteps += 1; // FUND_USDC
  if (config.trustlineCount >= 5) messSteps += 1; // FUND_EURC
  if (config.dataEntryCount > 0) messSteps += 1;
  if (config.offerCount > 0) messSteps += 1;
  if (config.addSigner) messSteps += 1;

  let demolishSteps = 1; // MERGE
  if (config.addSigner) demolishSteps += 1;
  if (config.dataEntryCount > 0) demolishSteps += 1;
  if (config.offerCount > 0) demolishSteps += 1;
  demolishSteps += config.trustlineCount; // CONVERT_ASSETS per trustline
  demolishSteps += 1; // REMOVE_TRUSTLINES

  return messSteps * MESS_S + demolishSteps * DEMOLISH_S;
}
