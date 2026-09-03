import type { Network } from "./network";
import type { DefiPositionsResult } from "./defi-position";
import type { PlanBlocker } from "./plan";

export type ClaimPredicate =
  | { type: "unconditional" }
  | { type: "and"; predicates: ClaimPredicate[] }
  | { type: "or"; predicates: ClaimPredicate[] }
  | { type: "not"; predicate: ClaimPredicate }
  | { type: "before_absolute_time"; absBeforeEpoch: string }
  | { type: "before_relative_time"; relBeforeSeconds: string; deadlineEpoch: string };

export interface ClaimableBalance {
  /** Full 72-char hex balance ID as returned by Horizon ("00000000" + 64-char hash). */
  id: string;
  /** "CODE:ISSUER" or "native" */
  asset: string;
  amount: string;
  /** One entry per claimant on the balance, each with its own predicate. */
  claimants: { destination: string; predicate: ClaimPredicate }[];
  /** Account sponsoring this balance's reserve, or null if unsponsored. */
  sponsor: string | null;
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

/**
 * A ledger entry this account currently sponsors, on another account (or itself, for
 * "account" - a fully-sponsored account creation). Mirrors the ledger-key kinds
 * RevokeSponsorship supports. Claimable balances have no owning-account concept in
 * their ledger key (unlike the other five kinds), so they carry only balanceId.
 */
export type SponsoredEntry =
  | { kind: "account"; owner: string }
  | { kind: "trustline"; owner: string; asset: string }
  | { kind: "offer"; owner: string; offerId: string }
  | { kind: "data_entry"; owner: string; name: string }
  | { kind: "signer"; owner: string; signerKey: string }
  | { kind: "claimable_balance"; balanceId: string };

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
  /** Ledger entries this account currently sponsors (on other accounts, or itself via a
   *  fully-sponsored account creation). Populated by replaying sponsorship-relevant
   *  operations and re-verifying each candidate's live sponsor - see sponsorship.ts. */
  sponsoredEntries: SponsoredEntry[];
  /** True when sponsoredEntries could not be enumerated completely (pagination cut off,
   *  a live re-verification fetch failed, or the enumerated count doesn't match
   *  numSponsoring). Mirrors subEntryMismatch: an incomplete read must never be treated
   *  as "sponsors nothing" downstream. */
  sponsorshipEnumerationIncomplete: boolean;
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
  /** Detected DeFi positions (Blend, Aquarius, Soroswap, Phoenix, FxDAO), resolved via OctoPos on
   *  mainnet or a direct contract read on testnet / mainnet degraded mode - architecture.md §7.1.
   *  Never absent: an unconfigured deployment or provider outage still returns a result, stamped
   *  with a null `timestamp` and reflected in `defiPositionsWarnings` rather than being omitted. */
  defiPositions: DefiPositionsResult;
  /** Plain-language notices from `assessDefiPositionsGate` (issue #147) - stale/unconfirmed data
   *  or an unrecognized position - reusing the exact same typed-blocker signal close/plan already
   *  gates on, so the analysis view and the plan never disagree about what's trustworthy. Empty
   *  when nothing needs flagging. */
  defiPositionsWarnings: PlanBlocker[];
}

export interface MediatorCheckResult {
  requiresMediator: boolean;
  reason: string;
  requiresMemo: boolean;
  memoType: "text" | "id" | "hash" | null;
  exchangeName: string | null;
  /** Whether the server can actually perform the mediator flow (secret configured). */
  available: boolean;
}
