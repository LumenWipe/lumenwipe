import type { Network } from "@/config/networks";
import { AccountNotFoundError } from "@/lib/utils/errors";
import { fetchOffersFromAdapter, fetchClaimableBalancesForClaimant } from "./horizon-adapter";
import { detectSubEntryMismatch } from "./scan-fallback";
import { horizonAssetToString } from "@/lib/utils/assets";
import type {
  AccountState,
  AccountSigner,
  ClaimableBalance,
  DataEntry,
  Trustline,
  PoolShareEntry,
} from "@/types/account";

// Reads the full account state via a Horizon-compatible API.
//
// Why Horizon and not Stellar RPC: the Soroban RPC getAccount call only returns
// sequence number and base reserve - it does not expose trustlines, open offers,
// data entries, or signers. Horizon returns all of that in a single call,
// with zero indexing lag for newly created accounts.
//
// Future: once Soroswap API or the xBull router expose an equivalent
// account-state endpoint we can drop the Horizon dependency here entirely.

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
      console.warn(`[account-live] unknown signer type "${raw}" on ${address}, skipping`);
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

export async function getLiveAccountState(
  address: string,
  network: Network = "testnet"
): Promise<AccountState> {
  const { PATH_ROUTING_API_URLS } = await import("@/config/networks");
  const base = PATH_ROUTING_API_URLS[network];
  if (!base) {
    throw new Error(`NEXT_PUBLIC_PATH_ROUTING_API_${network.toUpperCase()} is not configured`);
  }

  const accountRes = await fetch(`${base}/accounts/${address}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (accountRes.status === 404) throw new AccountNotFoundError(address);
  if (!accountRes.ok) throw new Error(`Account fetch failed: ${accountRes.status}`);
  const account = (await accountRes.json()) as ApiAccount;

  const nativeBalance = account.balances.find((b) => b.asset_type === "native");

  const trustlines: Trustline[] = account.balances
    .filter((b) => b.asset_type === "credit_alphanum4" || b.asset_type === "credit_alphanum12")
    .map((b) => ({
      asset: horizonAssetToString(b),
      balance: b.balance,
      limit: b.limit ?? "0",
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

  const openOffers = await fetchOffersFromAdapter(address, network);
  const claimableBalances: ClaimableBalance[] = await fetchClaimableBalancesForClaimant(
    address,
    network
  );
  const numSubEntries = account.subentry_count;

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
    numSponsoring: account.num_sponsoring ?? 0,
    sponsoredBy: account.sponsor ?? null,
    authImmutable: account.flags?.auth_immutable ?? false,
    trustlines,
    openOffers,
    poolShares,
    claimableBalances,
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
