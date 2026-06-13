import type { Network } from "@/config/networks";

export interface ClaimableBalance {
  /** Full 72-char hex balance ID as returned by Horizon ("00000000" + 64-char hash). */
  id: string;
  /** "CODE:ISSUER" or "native" */
  asset: string;
  amount: string;
}

export interface AccountSigner {
  key: string;
  weight: number;
  type: "ed25519_public_key" | "hash_x" | "preauth_tx" | "ed25519_signed_payload";
}

export interface AccountThresholds {
  low: number;
  med: number;
  high: number;
}

export interface DataEntry {
  key: string;
  value: string; // base64-encoded
}

export interface Trustline {
  asset: string; // "CODE:ISSUER" or "native"
  balance: string; // in lumens/units as string
  // Only provided by the Horizon-compatible reader; rpc getAssetBalance does not
  // expose it. Nothing consumes it (trustline removal always uses ChangeTrust limit 0).
  limit?: string;
  authorized: boolean;
  issuer: string;
  code: string;
}

export interface OpenOffer {
  id: string;
  selling: string; // "CODE:ISSUER" or "native"
  buying: string;
  amount: string;
  price: string;
}

export interface PoolShareEntry {
  poolId: string; // 64-char hex (without the L prefix)
}

export interface AccountState {
  address: string;
  network: Network;
  // From Stellar RPC
  sequence: string;
  nativeBalanceLumens: string;
  dataEntries: DataEntry[];
  signers: AccountSigner[];
  thresholds: AccountThresholds;
  numSubEntries: number;
  numSponsoring: number;
  /** Account whose reserve covers this account's base reserve, or null. Populated by the
   *  Horizon-based scan path only; the RPC getLedgerEntries response strips the outer
   *  LedgerEntry extension where sponsoringID lives, so it remains null on that path. */
  sponsoredBy: string | null;
  /** AUTH_IMMUTABLE flag is set - ACCOUNT_MERGE is permanently blocked. */
  authImmutable: boolean;
  // From SE API / Horizon adapter
  trustlines: Trustline[];
  openOffers: OpenOffer[];
  poolShares: PoolShareEntry[];
  /** Claimable balances where this account is listed as a claimant. Does not affect
   *  numSubEntries on this account; populated via the Horizon adapter. */
  claimableBalances: ClaimableBalance[];
  // True when the enumerated subentry count is lower than numSubEntries from the ledger -
  // indicates entries we could not enumerate (e.g. offers when adapter URL not configured).
  subEntryMismatch: boolean;
}

export interface MediatorCheckResult {
  requiresMediator: boolean;
  reason: string;
  requiresMemo: boolean;
  memoType: "text" | "id" | "hash" | null;
  exchangeName: string | null;
}
