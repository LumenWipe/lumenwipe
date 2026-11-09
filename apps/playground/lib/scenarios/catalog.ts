export const LWDEMO_CODE = "LWDEMO";

export type AssetCode =
  | "LWDEMO"
  | "AIRDROP1"
  | "RUGPULL"
  | "USDC"
  | "EURC"
  | "LWCOIN"
  | "LWGEM"
  | "BONUS"
  | "GIFT"
  | "PERK";
export type OfferAsset = AssetCode | "native";

/** Airdropped by their own throwaway issuer, which pays from inside the demo's transaction. */
export const AIRDROP_ASSETS = [
  { code: "AIRDROP1", amount: "1000000" },
  { code: "RUGPULL", amount: "13.37" },
] as const satisfies readonly { code: AssetCode; amount: string }[];

/** Bought on the DEX from their own throwaway issuer's offer, so the demo spends XLM on them. */
export const SWAP_ASSETS = [
  { code: "USDC", amount: "10" },
  { code: "EURC", amount: "10" },
] as const satisfies readonly { code: AssetCode; amount: string }[];

export const LWDEMO_AMOUNT = "25";

/**
 * Issued by the playground's persistent issuer, like LWDEMO, and paid to the demo by it. Each is
 * closed by the disposition the visitor picks: burned (returned to the issuer), converted to XLM
 * through the market maker's standing offer, or transferred to the session's own recipient.
 */
export const DISPOSITION_ASSETS = [
  { code: "LWCOIN", amount: "20" },
  { code: "LWGEM", amount: "8" },
] as const satisfies readonly { code: AssetCode; amount: string }[];

/** The assets the persistent issuer issues; every other one has a throwaway issuer per session. */
export const PERSISTENT_ASSETS = [
  LWDEMO_CODE,
  ...DISPOSITION_ASSETS.map((a) => a.code),
] as const satisfies readonly AssetCode[];

export function isPersistentAsset(code: string): boolean {
  return PERSISTENT_ASSETS.some((p) => p === code);
}

/**
 * The market maker's standing offers: each sells XLM for one persistent asset at this price, in
 * units of the asset per XLM, so converting N units delivers N / price XLM. A junk offer that buys
 * one of these assets with XLM is always priced above it (tests/unit/scenario-catalog.test.ts), so
 * another session's conversion fills the market maker, never this session's own offer.
 */
export const STANDING_LIQUIDITY_PRICE = "2";

/**
 * The least XLM, in stroops, the close may accept for converting `amount` of a persistent asset:
 * what the standing offer pays, less 1%. The API applies 0.5% slippage to its quote, so the floor
 * sits under its minimum while the offer has depth, and it comes from this configuration, never
 * from the API.
 */
export function conversionFloorStroops(amount: string): bigint {
  const STROOPS_PER_UNIT = BigInt(10_000_000);
  return (
    (BigInt(amount) * STROOPS_PER_UNIT * BigInt(99)) /
    (BigInt(STANDING_LIQUIDITY_PRICE) * BigInt(100))
  );
}

/** Claimable balances a throwaway issuer leaves for the demo: BONUS on a trustline the demo opens,
 *  GIFT on one it does not, so the close adds the trustline before it claims. */
export const CLAIM_BONUS_AMOUNT = "50";
export const CLAIM_GIFT_AMOUNT = "30";
/** A BONUS balance the demo can claim only after this long, well past the session's hour. */
export const TIME_GATED_AMOUNT = "5";
export const TIME_GATE_SECONDS = "7200";
/** The balance the demo itself creates, and so sponsors, for the claimant helper. */
export const DEMO_SPONSORED_CLAIM_XLM = "1";
/** The claimant helper: two base reserves and the fee of its claim. */
export const CLAIMANT_FUNDING_XLM = "1.5";

/** The sponsor helper pays the reserves of three demo entries on top of its own two. */
export const SPONSOR_FUNDING_XLM = "3";
/** A beneficiary that can take over the two reserves the demo sponsors for it. */
export const BENEFICIARY_FUNDING_XLM = "3";
/** A beneficiary left at its minimum balance, plus its own fees: it cannot take the reserves over. */
export const UNREVOCABLE_BENEFICIARY_FUNDING_XLM = "1.01";
/** The demo's data entry whose reserve the sponsor helper pays. */
export const SPONSORED_DATA_ENTRY = { key: "sponsored_note", value: "reserve paid elsewhere" };
/** The beneficiary's data entry whose reserve the demo pays. */
export const BENEFICIARY_DATA_ENTRY = { key: "sponsored_by_demo", value: "reserve paid by demo" };
/** The demo's offer whose reserve the sponsor helper pays. */
export const SPONSORED_OFFER = {
  selling: "native",
  buying: "PERK",
  amount: "1",
  price: "1",
} as const;

/** XLM the demo gives the session's transfer recipient: its two base reserves, one trustline per
 *  persistent asset and the fees of its own cleanup. */
export const RECIPIENT_FUNDING_XLM = "3";
/** XLM per swapped token: 0.2 x 10 = 2 XLM per swap. */
export const DEMO_SWAP_PRICE = "0.2";
export const FRIENDBOT_XLM = "10000";
/** XLM the demo keeps after returning the Friendbot excess to the market maker. */
export const DEMO_KEEP_XLM = "100";
export const EPHEMERAL_ISSUER_FUNDING_XLM = "3";
export const BASE_RESERVE_XLM = 0.5;

export const JUNK_DATA_ENTRIES = [
  { key: "promo_code", value: "WELCOME2024" },
  { key: "legacy_app_state", value: "deprecated" },
  { key: "airdrop_claim", value: "pending" },
  { key: "referral_id", value: "REF-ABC123" },
  { key: "kyc_status", value: "unverified" },
] as const;

/**
 * Never crosses the market maker's sell-XLM/buy-LWDEMO offer, and the one that buys LWDEMO is
 * priced above the standing offer, so a conversion elsewhere never fills it. Swap offers stay below
 * the swapped amount.
 */
export const JUNK_OFFERS = [
  { selling: "native", buying: LWDEMO_CODE, amount: "5", price: "3" },
  { selling: "AIRDROP1", buying: "native", amount: "500000", price: "0.0001" },
  { selling: "RUGPULL", buying: "native", amount: "10", price: "42" },
  { selling: "USDC", buying: "native", amount: "8", price: "10" },
  { selling: "EURC", buying: "native", amount: "8", price: "10" },
] as const satisfies readonly {
  selling: OfferAsset;
  buying: OfferAsset;
  amount: string;
  price: string;
}[];
