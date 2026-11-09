export const LWDEMO_CODE = "LWDEMO";

export type AssetCode = "LWDEMO" | "AIRDROP1" | "RUGPULL" | "USDC" | "EURC";
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

/** Never crosses the market maker's sell-XLM/buy-LWDEMO offer. Swap offers stay below the swapped amount. */
export const JUNK_OFFERS = [
  { selling: "native", buying: LWDEMO_CODE, amount: "5", price: "2" },
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
