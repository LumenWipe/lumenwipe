import type { Network } from "@/config/networks";
import { xlmToStroops } from "@/lib/utils/amounts";
import { horizonDepsFor } from "@/lib/stellar/account-state";
import { horizonPaginate, type HorizonDeps } from "@/lib/stellar/horizon-http";
import { pinnedHorizonSource } from "@/lib/stellar/provider-failover";

const ISSUANCE_PAGE_LIMIT = 200;
const ISSUANCE_MAX_ASSETS = 2_000;
const ISSUANCE_READ_POLICY = { maxRetries: 1, perAttemptMs: 4_000 } as const;

/** A failed read is not an answer: it must never be taken for "this account issues nothing". */
export class IssuerReadError extends Error {
  constructor() {
    super("The assets issued by this account could not be read. Retry in a moment.");
    this.name = "IssuerReadError";
  }
}

export interface IssuanceSummary {
  /** Assets issued by the closing account with units still outstanding. */
  assetCount: number;
  /** Trustlines, claimable balances, pool and contract holdings across those assets. */
  holderCount: number;
}

export interface IssuanceDeps {
  horizon: (network: Network) => HorizonDeps;
}

export const defaultIssuanceDeps = (): IssuanceDeps => ({
  horizon: (network) => {
    const base: HorizonDeps = pinnedHorizonSource(network) ?? horizonDepsFor(network);
    return { ...base, client: { ...base.client, policy: ISSUANCE_READ_POLICY } };
  },
});

interface AssetStats {
  num_claimable_balances: number;
  num_liquidity_pools: number;
  num_contracts: number;
  accounts: Record<string, number>;
  balances: Record<string, string>;
  claimable_balances_amount: string;
  liquidity_pools_amount: string;
  contracts_amount: string;
}

function summarize(records: AssetStats[]): IssuanceSummary | null {
  let assetCount = 0;
  let holderCount = 0;
  for (const r of records) {
    const accounts = Object.values(r.accounts);
    const counts = [r.num_claimable_balances, r.num_liquidity_pools, r.num_contracts];
    if (!accounts.every(Number.isInteger) || !counts.every(Number.isInteger)) {
      throw new IssuerReadError();
    }
    const amounts = [
      ...Object.values(r.balances),
      r.claimable_balances_amount,
      r.liquidity_pools_amount,
      r.contracts_amount,
    ];
    if (!amounts.some((a) => BigInt(xlmToStroops(a)) > 0n)) continue;
    assetCount += 1;
    holderCount += accounts.reduce((n, c) => n + c, 0) + counts.reduce((n, c) => n + c, 0);
  }
  return assetCount > 0 ? { assetCount, holderCount } : null;
}

/**
 * Whether the closing account issued assets that are still held, and how many.
 *
 * A provider running with asset statistics disabled answers 200 with no records, which reads
 * as "issues nothing"; that case cannot be told apart from a real empty result. Any other
 * failure, including a 404, is an `IssuerReadError`. That is why this never fails over: an empty
 * answer opens the issuer gate, and moving to another provider after an outage would trade a
 * refusal for that. It reads the provider the account snapshot came from, or the primary, so a
 * snapshot that failed over carries this read with it: every provider in a list needs asset stats,
 * the same reliance a lone provider has always had.
 */
export async function assessIssuance(
  address: string,
  network: Network,
  deps: IssuanceDeps = defaultIssuanceDeps()
): Promise<IssuanceSummary | null> {
  try {
    const records = await horizonPaginate<AssetStats>(
      `/assets?asset_issuer=${address}&limit=${ISSUANCE_PAGE_LIMIT}`,
      deps.horizon(network),
      ISSUANCE_PAGE_LIMIT,
      ISSUANCE_MAX_ASSETS
    );
    return summarize(records);
  } catch (e) {
    throw e instanceof IssuerReadError ? e : new IssuerReadError();
  }
}
