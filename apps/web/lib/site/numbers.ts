import registry from "@registry/contract-registry.json";
import { BASE_RESERVE_XLM, MINIMUM_BALANCE_RESERVES } from "@/lib/site/reserve";
import { LIVE_EXIT_PROTOCOLS } from "@/lib/site/status";

export type StatSource =
  | { kind: "registry"; file: string }
  | { kind: "external"; href: string; label: string; asOf: string };

export interface SiteStat {
  value: string;
  label: string;
  source: StatSource;
}

const RESERVE_SOURCE: StatSource = {
  kind: "external",
  href: "https://developers.stellar.org/docs/learn/fundamentals/lumens#minimum-balance",
  label: "Stellar docs",
  asOf: "2026-11-14",
};

const REGISTRY_FILE = "apps/api/src/config/contract-registry.json";

/** "Nov 2026" for "2026-11-14". */
export function monthYear(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export const STATS: readonly SiteStat[] = [
  {
    value: `${MINIMUM_BALANCE_RESERVES * BASE_RESERVE_XLM} XLM plus ${BASE_RESERVE_XLM} per item`,
    label:
      "locked in reserve per account, where an item is a trustline, offer, data entry or signer",
    source: RESERVE_SOURCE,
  },
  {
    value: String(LIVE_EXIT_PROTOCOLS.length),
    label: "DeFi protocols with a mainnet exit",
    source: { kind: "registry", file: REGISTRY_FILE },
  },
  {
    value: monthYear(registry.lastVerified),
    label: "protocol contracts last checked against their live code",
    source: { kind: "registry", file: REGISTRY_FILE },
  },
];

export interface ReserveRow {
  label: string;
  xlm: number;
}

/** An illustrative account, priced from the base reserve. */
export const RESERVE_EXAMPLE: readonly ReserveRow[] = [
  { label: "Account minimum", xlm: MINIMUM_BALANCE_RESERVES * BASE_RESERVE_XLM },
  { label: "4 trustlines", xlm: 4 * BASE_RESERVE_XLM },
  { label: "2 open offers", xlm: 2 * BASE_RESERVE_XLM },
  { label: "1 data entry · 1 signer", xlm: 2 * BASE_RESERVE_XLM },
];

export const RESERVE_EXAMPLE_TOTAL = RESERVE_EXAMPLE.reduce((sum, r) => sum + r.xlm, 0);
