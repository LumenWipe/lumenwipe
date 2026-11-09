import type { AssetCode, OfferAsset } from "./catalog";

export const MESS_STEP_IDS = [
  "SETUP",
  "TRUST_AIRDROP1",
  "TRUST_RUGPULL",
  "TRUST_LWDEMO",
  "TRUST_USDC",
  "TRUST_EURC",
  "FUND_RARE",
  "FUND_LWDEMO",
  "FUND_USDC",
  "FUND_EURC",
  "DATA_ENTRIES",
  "OFFERS",
  "ADD_SIGNER",
] as const;

export type MessStepId = (typeof MESS_STEP_IDS)[number];

export function isMessStepId(value: string): value is MessStepId {
  return MESS_STEP_IDS.some((id) => id === value);
}

/** What the server executor does for a step, as data. Each kind has one executor in mess-builders. */
export type StepAction =
  | {
      kind: "setup";
      ephemeralAssets: AssetCode[];
      issuerFundingXlm: string;
      friendbotXlm: string;
      keepXlm: string;
    }
  | { kind: "change_trust"; asset: AssetCode }
  | { kind: "airdrops"; payments: { asset: AssetCode; amount: string }[] }
  | { kind: "issuer_payment"; asset: AssetCode; amount: string }
  | { kind: "dex_swap"; asset: AssetCode; amount: string; price: string }
  | { kind: "manage_data"; entries: { key: string; value: string }[] }
  | {
      kind: "offers";
      offers: { selling: OfferAsset; buying: OfferAsset; amount: string; price: string }[];
    }
  | { kind: "add_signer" };

export type StepActionKind = StepAction["kind"];

export const SCENE_NODE_KINDS = ["trustline", "offer", "data", "signer"] as const;

export type SceneNodeKind = (typeof SCENE_NODE_KINDS)[number];

export interface SceneNodeSpec {
  id: string;
  kind: SceneNodeKind;
  label: string;
}

export interface MessStepDef {
  id: MessStepId;
  label: string;
  /** Scene nodes that dock when this step's transaction confirms. */
  nodes: SceneNodeSpec[];
  /** Already-docked nodes whose balance this step sets. */
  balances: { nodeId: string; balance: string }[];
  action: StepAction;
}

/** Operation types a close can contain, named as `@stellar/stellar-sdk` names them. */
export type CloseOperationType =
  | "accountMerge"
  | "payment"
  | "changeTrust"
  | "manageData"
  | "manageSellOffer"
  | "manageBuyOffer"
  | "setOptions"
  | "pathPaymentStrictSend"
  | "claimClaimableBalance"
  | "revokeAccountSponsorship"
  | "revokeTrustlineSponsorship"
  | "revokeOfferSponsorship"
  | "revokeDataSponsorship"
  | "revokeSignerSponsorship"
  | "revokeClaimableBalanceSponsorship"
  | "invokeHostFunction";

/** What closing a scenario's entries takes: the verifier's expectation and operation ceiling come from these. */
export interface ScenarioExpectation {
  assets: AssetCode[];
  offers: number;
  dataEntries: number;
  signers: number;
  /** The close operations these entries need, excluding the final merge and threshold reset. */
  closeOperations: number;
  operationTypes: CloseOperationType[];
}

export interface ScenarioCost {
  /** XLM the session spends or locks for these entries. */
  xlm: number;
  classicTransactions: number;
  sorobanTransactions: number;
  seconds: number;
  /** Accounts closed in one batch, for a scenario that closes several. */
  batchSize: number;
  subEntries: number;
}

export interface IntParam {
  label: string;
  min: number;
  max: number;
  default: number;
}

export type ScenarioId =
  | "lwdemo-holding"
  | "junk-airdrops"
  | "stablecoin-swaps"
  | "data-entries"
  | "stale-offers"
  | "forgotten-signer";

export interface OrderedStep {
  /** Steps from every scenario are sorted by this key into one plan. */
  order: number;
  step: MessStepDef;
}

export interface ScenarioBuild {
  steps: OrderedStep[];
  /** Assets that need a throwaway issuer created at setup. */
  ephemeralAssets: AssetCode[];
  expectation: ScenarioExpectation;
  cost: ScenarioCost;
}

export interface BuildContext {
  /** Trustlines the whole selection opens, which an offer needs for both its assets. */
  heldAssets: readonly AssetCode[];
}

export type BuildResult = { ok: true; build: ScenarioBuild } | { ok: false; message: string };

export interface ScenarioDefinition {
  id: ScenarioId;
  label: string;
  description: string;
  params: Readonly<Record<string, IntParam>>;
  /** Trustlines this scenario opens, known from its params alone. */
  heldAssets: (params: Readonly<Record<string, number>>) => AssetCode[];
  /** At least one of these must also be selected. */
  requiresAnyOf: readonly ScenarioId[];
  conflicts: readonly ScenarioId[];
  build: (params: Readonly<Record<string, number>>, ctx: BuildContext) => BuildResult;
}

export interface ScenarioChoice {
  id: ScenarioId;
  params: Record<string, number>;
}

export interface ScenarioSelection {
  scenarios: ScenarioChoice[];
}
