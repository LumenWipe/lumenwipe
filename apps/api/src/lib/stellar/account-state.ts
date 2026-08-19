import { type Network, PATH_ROUTING_API_URLS } from "@/config/networks";
import { AccountNotFoundError } from "@/lib/utils/errors";
import { fetchOffersFromAdapter, fetchClaimableBalancesForClaimant } from "./horizon-adapter";
import { detectSubEntryMismatch } from "./scan-fallback";
import { horizonAssetToString } from "@/lib/utils/assets";
import { enumerateSponsoredEntries } from "@/lib/stellar/sponsorship";
import { horizonGet, type HorizonDeps } from "./horizon-http";
import type {
  AccountState,
  AccountSigner,
  DataEntry,
  Trustline,
  PoolShareEntry,
} from "@lumenwipe/types";

/**
 * Reads full account state from one Horizon-compatible provider.
 *
 * Why Horizon and not Stellar RPC: `getAccount` returns only the sequence number and base
 * reserve, and `getLedgerEntries` can fetch a ledger entry whose key you already know but
 * cannot *enumerate* an account's trustlines or offers. Closing an account requires
 * enumerating every sub-entry and proving the enumeration is complete, which structurally
 * needs an indexer. Horizon's deprecation does not change this: its named successor cannot do
 * this job.
 *
 * Why one call and not a per-asset loop: `/accounts/{id}` returns balances, data entries,
 * signers, thresholds, flags and subentry_count together. The previous implementation
 * enumerated asset codes from an indexer that did not carry balances and then issued one RPC
 * read per trustline, so a single inbound request fanned out to hundreds of upstream calls.
 *
 * Swapping providers is a `baseUrl` change - SDF, Blockdaemon, Validation Cloud, a
 * self-hosted instance - which is why the seam is configuration plus an injectable transport
 * rather than a provider interface.
 */

// Horizon returns signer types with different naming conventions than the SDK.
// Validate explicitly rather than casting to catch unknown types early.
const HORIZON_SIGNER_TYPE_MAP: Record<string, AccountSigner["type"]> = {
  ed25519_public_key: "ed25519_public_key",
  "hash(x)": "hash_x",
  preauth_tx: "preauth_tx",
  ed25519_signed_payload: "ed25519_signed_payload",
};

function parseHorizonSignerType(raw: string, address: string): AccountSigner["type"] | null {
  const mapped = HORIZON_SIGNER_TYPE_MAP[raw];
  if (!mapped) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(`[account-state] unknown signer type "${raw}" on ${address}, skipping`);
    }
    return null;
  }
  return mapped;
}

interface ApiBalance {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  liquidity_pool_id?: string;
  balance: string;
  limit?: string;
  is_authorized?: boolean;
}

interface ApiAccount {
  sequence: string;
  subentry_count: number;
  thresholds: { low_threshold: number; med_threshold: number; high_threshold: number };
  signers: Array<{ key: string; weight: number; type: string }>;
  balances: ApiBalance[];
  data: Record<string, string>;
  flags?: { auth_immutable: boolean };
  sponsor?: string;
  num_sponsoring?: number;
}

/**
 * Rejects a response we cannot build a safe plan from.
 *
 * The endpoint is Horizon-*compatible*, not Horizon, so field presence is a trust signal
 * rather than an assumption. `subentry_count` matters most: the completeness check is
 * `enumerated < numSubEntries`, and JavaScript evaluates `7 < undefined` as false, so a
 * provider that omits the field would turn the one guard this design rests on into a
 * permanent, silent "everything is fine". `flags` matters for the same reason in the other
 * direction - a missing AUTH_IMMUTABLE would let the tool walk a user through selling assets
 * and removing trustlines for an account that can never be merged.
 *
 * Everything here fails the read rather than defaulting, because there is no safe default for
 * "we could not tell".
 */
function assertUsableAccountBody(account: ApiAccount, address: string): void {
  const missing: string[] = [];
  if (typeof account.subentry_count !== "number") missing.push("subentry_count");
  if (!Array.isArray(account.balances)) missing.push("balances");
  if (!Array.isArray(account.signers)) missing.push("signers");
  const t = account.thresholds;
  // All three, not just `high`: `med` gates signer normalization
  // (`thresholds.med > 1` in the plan builder), and an undefined there compares false, so an
  // account needing normalization would skip it.
  if (
    !t ||
    typeof t.low_threshold !== "number" ||
    typeof t.med_threshold !== "number" ||
    typeof t.high_threshold !== "number"
  ) {
    missing.push("thresholds");
  }
  if (typeof account.flags?.auth_immutable !== "boolean") missing.push("flags.auth_immutable");
  if (typeof account.sequence !== "string") missing.push("sequence");

  if (missing.length > 0) {
    throw new Error(
      `The configured account-state provider returned an unusable response for ${address}: ` +
        `missing or malformed ${missing.join(", ")}. Closing an account requires proving the ` +
        `enumeration is complete, which these fields carry.`
    );
  }
}

/** Resolves the configured provider for a network. Throws rather than reading from nowhere. */
export function horizonDepsFor(network: Network, fetchImpl?: typeof globalThis.fetch): HorizonDeps {
  const baseUrl = PATH_ROUTING_API_URLS[network];
  if (!baseUrl) {
    throw new Error(`NEXT_PUBLIC_PATH_ROUTING_API_${network.toUpperCase()} is not configured`);
  }
  return { baseUrl, fetch: fetchImpl };
}

export async function readAccountStateFrom(
  address: string,
  network: Network,
  deps: HorizonDeps
): Promise<AccountState> {
  const account = await horizonGet<ApiAccount>(`/accounts/${address}`, deps);
  if (!account) throw new AccountNotFoundError(address);
  assertUsableAccountBody(account, address);

  const nativeBalance = account.balances.find((b) => b.asset_type === "native");

  const trustlines: Trustline[] = account.balances
    .filter((b) => b.asset_type === "credit_alphanum4" || b.asset_type === "credit_alphanum12")
    .map((b) => ({
      asset: horizonAssetToString(b),
      balance: b.balance,
      // Left undefined when the provider omits it, never defaulted to "0". A fabricated zero
      // is indistinguishable from a trustline with no room at all, which would make every
      // transfer into that line look impossible (see hasRoomFor in close-api/transfer-destinations).
      limit: b.limit,
      authorized: b.is_authorized ?? true,
      issuer: b.asset_issuer!,
      code: b.asset_code!,
    }));

  const poolShares: PoolShareEntry[] = account.balances
    .filter((b) => b.asset_type === "liquidity_pool_shares" && b.liquidity_pool_id)
    .map((b) => ({ poolId: b.liquidity_pool_id! }));

  const dataEntries: DataEntry[] = Object.entries(account.data ?? {}).map(([key, value]) => ({
    key,
    value,
  }));

  const signers: AccountSigner[] = account.signers
    .map((s) => {
      const type = parseHorizonSignerType(s.type, address);
      if (!type) return null;
      return { key: s.key, weight: s.weight, type };
    })
    .filter((s): s is AccountSigner => s !== null);

  const [openOffers, claimableBalances] = await Promise.all([
    fetchOffersFromAdapter(address, deps),
    fetchClaimableBalancesForClaimant(address, deps),
  ]);
  const numSubEntries = account.subentry_count;

  // `?? 0` would turn a missing field into a confident "sponsors nothing". The endpoint is
  // only Horizon-compatible, not Horizon, so presence is the trust signal: an absent
  // num_sponsoring means we do not know, and enumerateSponsoredEntries is told so.
  const numSponsoringKnown = typeof account.num_sponsoring === "number";
  const numSponsoring = account.num_sponsoring ?? 0;
  const { sponsoredEntries, sponsorshipEnumerationIncomplete } = await enumerateSponsoredEntries(
    address,
    network,
    numSponsoring,
    numSponsoringKnown
  );

  return {
    address,
    network,
    sequence: account.sequence,
    nativeBalanceLumens: nativeBalance?.balance ?? "0",
    dataEntries,
    signers,
    thresholds: {
      low: account.thresholds.low_threshold,
      med: account.thresholds.med_threshold,
      high: account.thresholds.high_threshold,
    },
    numSubEntries,
    numSponsoring,
    sponsoredEntries,
    sponsorshipEnumerationIncomplete,
    sponsoredBy: account.sponsor ?? null,
    authImmutable: account.flags?.auth_immutable ?? false,
    trustlines,
    openOffers,
    poolShares,
    claimableBalances,
    // Ground truth for completeness: numSubEntries is what the ledger says the account holds.
    // Enumerating fewer means the plan would leave entries behind and the merge would fail
    // with op_has_sub_entries, so a mismatch has to reach the caller as a blocker. There is no
    // second path to re-check against any more - with one zero-lag provider a mismatch is the
    // answer, not a prompt to look again.
    subEntryMismatch: detectSubEntryMismatch({
      address,
      signers,
      trustlines,
      openOffers,
      dataEntries,
      poolShares,
      numSubEntries,
    }),
  };
}


/**
 * Reads only what is needed to judge whether an account can receive a payment: that it exists,
 * and its trustlines.
 *
 * Deliberately not `readAccountState`. That one also paginates offers and claimable balances and
 * can enumerate up to 2000 sponsorship operations - three to fifteen upstream requests for an
 * account whose offers and sponsorships are irrelevant here. Since a caller names these
 * addresses freely and there can be one per asset, using the full reader would turn a single
 * inbound request into an unbounded fan-out against a shared Horizon budget: exactly the
 * amplification #110 removed from the account path. It also cannot raise
 * TruncatedCollectionError, which the full reader throws for a destination holding more than
 * 1000 offers - a fact about the destination that has no bearing on its ability to be paid.
 */
export async function readTrustlinesOnly(
  address: string,
  network: Network = "testnet",
  deps: HorizonDeps = horizonDepsFor(network)
): Promise<Pick<AccountState, "address" | "trustlines"> | null> {
  const account = await horizonGet<ApiAccount>(`/accounts/${address}`, deps);
  if (!account) return null;
  if (!Array.isArray(account.balances)) {
    throw new Error(
      `Horizon returned an account body for ${address} with no balances; refusing to treat ` +
        `absent data as "holds no trustlines".`
    );
  }
  return {
    address,
    trustlines: account.balances
      .filter((b) => b.asset_type === "credit_alphanum4" || b.asset_type === "credit_alphanum12")
      .map((b) => ({
        asset: horizonAssetToString(b),
        balance: b.balance,
        limit: b.limit,
        authorized: b.is_authorized ?? true,
        issuer: b.asset_issuer!,
        code: b.asset_code!,
      })),
  };
}

/** Reads account state from the provider configured for `network`. */
export async function getAccountState(
  address: string,
  network: Network = "testnet"
): Promise<AccountState> {
  return readAccountStateFrom(address, network, horizonDepsFor(network));
}
