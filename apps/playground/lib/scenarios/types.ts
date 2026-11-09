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
  "TRUST_LWCOIN",
  "TRUST_LWGEM",
  "FUND_LWCOIN",
  "FUND_LWGEM",
  "OPEN_RECIPIENT",
  "TRUST_BONUS",
  "CLAIMABLE_BALANCES",
  "SPONSORED_ENTRIES",
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
      /** What the market maker funds the demo with when the session is created. */
      fundingXlm: string;
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
  | { kind: "add_signer" }
  | { kind: "open_recipient"; fundingXlm: string; assets: AssetCode[] }
  | { kind: "claimable_balances"; balances: ClaimableBalanceSpec[]; claimantFundingXlm: string }
  | {
      kind: "sponsored_entries";
      variant: SponsorshipVariant;
      asset: AssetCode;
      dataEntry: { key: string; value: string };
      helperFundingXlm: string;
    };

/**
 * How the close treats a claimable balance the mess creates: the demo claims it, adds the trustline
 * and then claims it, forfeits it (it cannot be claimed during the session), or, for a balance the
 * demo itself created for the claimant helper, cannot revoke it until the helper claims it.
 */
export type ClaimIntent = "claim" | "add_trustline_then_claim" | "forfeit" | "demo_sponsored";

export interface ClaimableBalanceSpec {
  asset: AssetCode | "native";
  amount: string;
  intent: ClaimIntent;
}

/**
 * sponsor_pays: a sponsor helper pays the reserves of the demo's entries. demo_sponsors: the demo
 * pays for a beneficiary helper's entries, which the close revokes. unrevocable: the same, with a
 * beneficiary that cannot take the reserves over, which the close reports as a blocker.
 */
export type SponsorshipVariant = "sponsor_pays" | "demo_sponsors" | "unrevocable";

/** A playground-owned account a step creates beside the demo; its key is kept in the session. */
export type HelperRole = "claimant" | "sponsor" | "beneficiary";

/** The helper a step's action creates, if any. */
export function helperRoleOf(action: StepAction): HelperRole | null {
  if (action.kind === "claimable_balances") {
    return action.balances.some((b) => b.intent === "demo_sponsored") ? "claimant" : null;
  }
  if (action.kind === "sponsored_entries") {
    return action.variant === "sponsor_pays" ? "sponsor" : "beneficiary";
  }
  return null;
}

/** An entry of the beneficiary helper whose reserve the demo pays, which the close may revoke. */
export type PlannedSponsoredEntry =
  { kind: "trustline"; asset: AssetCode } | { kind: "data_entry"; name: string };

/** What the playground does, with a helper's key, when the close reports a blocker it planned. */
export type ResolutionKind = "claim_sponsored_balance" | "release_sponsored_entries";

export interface PlannedResolution {
  /** The API's blocker code. */
  blocker: string;
  kind: ResolutionKind;
}

export type StepActionKind = StepAction["kind"];

export const SCENE_NODE_KINDS = ["trustline", "offer", "data", "signer"] as const;

export type SceneNodeKind = (typeof SCENE_NODE_KINDS)[number];

export interface SceneNodeSpec {
  id: string;
  kind: SceneNodeKind;
  label: string;
  /** For an offer node: the pair it trades, which binds it to the chain's offer id once posted. */
  offer?: { selling: OfferAsset; buying: OfferAsset };
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

/** How the close disposes of a persistent asset's balance; "burn" returns it to its issuer. */
export type DispositionChoice = "burn" | "convert" | "transfer";

/** The order a disposition parameter's values stand for. */
export const DISPOSITION_CHOICES: readonly DispositionChoice[] = ["burn", "convert", "transfer"];

/** A balance the session chose a disposition for, with the amount the mess paid into it. */
export interface AssetDisposition {
  asset: AssetCode;
  choice: DispositionChoice;
  amount: string;
}

/** What closing a scenario's entries takes: the verifier's expectation and operation ceiling come from these. */
export interface ScenarioExpectation {
  assets: AssetCode[];
  offers: number;
  dataEntries: number;
  signers: number;
  /** The close operations these entries need, excluding the final merge and threshold reset. */
  closeOperations: number;
  operationTypes: CloseOperationType[];
  /** Assets closed other than by a return to the issuer; every other asset is returned. */
  dispositions: AssetDisposition[];
  /** Assets the close adds a trustline for, claims, then returns and removes. */
  arrivingAssets: AssetCode[];
  /** Entries the demo sponsors on its beneficiary helper. */
  sponsoredEntries: PlannedSponsoredEntry[];
  /** Blockers this selection expects the close to report, each with its resolution. */
  resolutions: PlannedResolution[];
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
  /** Names for the values min to max, for a parameter that picks one option rather than a count. */
  choices?: readonly string[];
}

export type ScenarioId =
  | "lwdemo-holding"
  | "junk-airdrops"
  | "stablecoin-swaps"
  | "data-entries"
  | "stale-offers"
  | "forgotten-signer"
  | "dispositions"
  | "claimable-balances"
  | "sponsored-reserves";

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

/** The feature sets presets and the toggle list are grouped by. */
export type FeatureSetId = "classic" | "protocol" | "api";

export interface ScenarioDefinition {
  id: ScenarioId;
  featureSet: FeatureSetId;
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
