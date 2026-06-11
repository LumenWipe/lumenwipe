// Declarative definition of the playground "mess" sequence. Isomorphic: the
// server executes these steps (see mess-builders.ts) and the client uses the
// same definitions to drive the orbital scene, so animation and chain reality
// can never drift apart.

export const LWDEMO_CODE = "LWDEMO";

export const EPHEMERAL_ASSETS = [
  { code: "AIRDROP1", amount: "1000000" },
  { code: "RUGPULL", amount: "13.37" },
] as const;

export const LWDEMO_AMOUNT = "25";

// XLM the demo keeps after returning the friendbot excess to the market maker.
// Keeping it small makes the locked-reserve counter visually meaningful.
export const DEMO_KEEP_XLM = "30";
export const EPHEMERAL_ISSUER_FUNDING_XLM = "3";

export const JUNK_DATA_ENTRIES = [
  { key: "promo_code", value: "WELCOME2024" },
  { key: "legacy_app_state", value: "deprecated" },
  { key: "airdrop_claim", value: "pending" },
] as const;

// Junk offers designed to NEVER cross with the market maker's liquidity offer
// (which sells XLM / buys LWDEMO): the first sits on the same side of that
// book, the other two sell assets nobody bids on.
export const JUNK_OFFERS = [
  { selling: "native", buying: LWDEMO_CODE, amount: "5", price: "2" },
  { selling: "AIRDROP1", buying: "native", amount: "500000", price: "0.0001" },
  { selling: "RUGPULL", buying: "native", amount: "10", price: "42" },
] as const;

export type MessStepId =
  | "SETUP"
  | "TRUST_AIRDROP1"
  | "TRUST_RUGPULL"
  | "TRUST_LWDEMO"
  | "FUND_RARE"
  | "FUND_LWDEMO"
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

export const MESS_PLAN: MessStepDef[] = [
  {
    id: "SETUP",
    label: "Fund demo account & spawn rogue issuers",
    nodeIds: [],
    updatesNodeIds: [],
  },
  {
    id: "TRUST_AIRDROP1",
    label: "Open AIRDROP1 trustline",
    nodeIds: ["tl:AIRDROP1"],
    updatesNodeIds: [],
  },
  {
    id: "TRUST_RUGPULL",
    label: "Open RUGPULL trustline",
    nodeIds: ["tl:RUGPULL"],
    updatesNodeIds: [],
  },
  {
    id: "TRUST_LWDEMO",
    label: "Open LWDEMO trustline",
    nodeIds: ["tl:LWDEMO"],
    updatesNodeIds: [],
  },
  {
    id: "FUND_RARE",
    label: "Receive junk token airdrops",
    nodeIds: [],
    updatesNodeIds: ["tl:AIRDROP1", "tl:RUGPULL"],
  },
  {
    id: "FUND_LWDEMO",
    label: `Receive ${LWDEMO_AMOUNT} LWDEMO`,
    nodeIds: [],
    updatesNodeIds: ["tl:LWDEMO"],
  },
  {
    id: "DATA_ENTRIES",
    label: "Attach leftover data entries",
    nodeIds: JUNK_DATA_ENTRIES.map((d) => `data:${d.key}`),
    updatesNodeIds: [],
  },
  {
    id: "OFFERS",
    label: "Post stale DEX offers",
    nodeIds: JUNK_OFFERS.map((_, i) => `offer:${i}`),
    updatesNodeIds: [],
  },
  {
    id: "ADD_SIGNER",
    label: "Add a forgotten co-signer",
    nodeIds: ["signer:extra"],
    updatesNodeIds: [],
  },
];

export function isMessStepId(value: string): value is MessStepId {
  return MESS_PLAN.some((s) => s.id === value);
}
