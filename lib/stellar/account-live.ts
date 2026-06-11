import { PATH_ROUTING_API_URLS } from "@/config/networks";
import { AccountNotFoundError } from "@/lib/utils/errors";
import type { AccountState, AccountSigner, DataEntry, OpenOffer, Trustline } from "@/types/account";

// Reads the full account state for the testnet playground via Horizon REST API.
//
// Why Horizon and not Stellar RPC: the Soroban RPC getAccount call only returns
// sequence number and base reserve - it does not expose trustlines, open offers,
// data entries, or signers. Horizon returns all of that in two calls
// (/accounts/{id} + /accounts/{id}/offers), with zero indexing lag for newly
// created accounts (unlike stellar.expert, which was the previous approach).
//
// Future: once Soroswap API or the xBull router expose an equivalent
// account-state endpoint we can drop the Horizon dependency here entirely.

interface ApiBalance {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
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
  sponsor?: string;
}

interface ApiOffersPage {
  _embedded?: {
    records?: Array<{
      id: string | number;
      selling: { asset_type: string; asset_code?: string; asset_issuer?: string };
      buying: { asset_type: string; asset_code?: string; asset_issuer?: string };
      amount: string;
      price: string;
    }>;
  };
}

function assetStr(a: { asset_type: string; asset_code?: string; asset_issuer?: string }): string {
  if (a.asset_type === "native") return "native";
  return `${a.asset_code}:${a.asset_issuer}`;
}

export async function getLiveAccountState(address: string): Promise<AccountState> {
  const base = PATH_ROUTING_API_URLS.testnet;
  if (!base) {
    throw new Error("NEXT_PUBLIC_PATH_ROUTING_API_TESTNET is not configured");
  }

  const accountRes = await fetch(`${base}/accounts/${address}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (accountRes.status === 404) throw new AccountNotFoundError(address);
  if (!accountRes.ok) throw new Error(`Account fetch failed: ${accountRes.status}`);
  const account = (await accountRes.json()) as ApiAccount;

  const offersRes = await fetch(`${base}/accounts/${address}/offers?limit=200`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!offersRes.ok) throw new Error(`Offers fetch failed: ${offersRes.status}`);
  const offersPage = (await offersRes.json()) as ApiOffersPage;

  const nativeBalance = account.balances.find((b) => b.asset_type === "native");

  const trustlines: Trustline[] = account.balances
    .filter((b) => b.asset_type === "credit_alphanum4" || b.asset_type === "credit_alphanum12")
    .map((b) => ({
      asset: `${b.asset_code}:${b.asset_issuer}`,
      balance: b.balance,
      limit: b.limit ?? "0",
      authorized: b.is_authorized ?? true,
      issuer: b.asset_issuer!,
      code: b.asset_code!,
    }));

  const dataEntries: DataEntry[] = Object.entries(account.data ?? {}).map(([key, value]) => ({
    key,
    value,
  }));

  const signers: AccountSigner[] = account.signers.map((s) => ({
    key: s.key,
    weight: s.weight,
    type: s.type as AccountSigner["type"],
  }));

  const openOffers: OpenOffer[] = (offersPage._embedded?.records ?? []).map((o) => ({
    id: String(o.id),
    selling: assetStr(o.selling),
    buying: assetStr(o.buying),
    amount: o.amount,
    price: o.price,
  }));

  return {
    address,
    network: "testnet",
    sequence: account.sequence,
    nativeBalanceLumens: nativeBalance?.balance ?? "0",
    dataEntries,
    signers,
    thresholds: {
      low: account.thresholds.low_threshold,
      med: account.thresholds.med_threshold,
      high: account.thresholds.high_threshold,
    },
    numSubEntries: account.subentry_count,
    sponsoredBy: account.sponsor ?? null,
    trustlines,
    openOffers,
  };
}
