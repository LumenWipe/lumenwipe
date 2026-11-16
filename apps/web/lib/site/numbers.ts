import registry from "@registry/contract-registry.json";
import { formatDate } from "@/lib/i18n/format";
import { SITE_LOCALE } from "@/lib/i18n/locale";
import { SITE } from "@/lib/i18n/messages/site";
import { BASE_RESERVE_XLM, MINIMUM_BALANCE_RESERVES } from "@/lib/site/reserve";
import { feature, LIVE_EXIT_PROTOCOLS, type SiteStatus } from "@/lib/site/status";

export type StatSource =
  | { kind: "registry"; file: string }
  | { kind: "external"; href: string; label: string; asOf: string };

export interface SiteStat {
  value: string;
  label: string;
  source: StatSource;
}

const COPY = SITE[SITE_LOCALE].numbers;

const RESERVE_SOURCE: StatSource = {
  kind: "external",
  href: "https://developers.stellar.org/docs/learn/fundamentals/lumens#minimum-balance",
  label: COPY.reserveSource,
  asOf: "2026-11-14",
};

const REGISTRY_FILE = "apps/api/src/config/contract-registry.json";

/** "Nov 2026" for "2026-11-14". */
export function monthYear(isoDate: string): string {
  return formatDate(SITE_LOCALE, `${isoDate}T00:00:00Z`, {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export const STATS: readonly SiteStat[] = [
  {
    value: COPY.reserveValue(MINIMUM_BALANCE_RESERVES * BASE_RESERVE_XLM, BASE_RESERVE_XLM),
    label: COPY.reserveLabel,
    source: RESERVE_SOURCE,
  },
  {
    value: String(LIVE_EXIT_PROTOCOLS.length),
    label: COPY.liveExitsLabel,
    source: { kind: "registry", file: REGISTRY_FILE },
  },
  {
    value: monthYear(registry.lastVerified),
    label: COPY.lastVerifiedLabel,
    source: { kind: "registry", file: REGISTRY_FILE },
  },
];

export interface ReserveRow {
  label: string;
  xlm: number;
}

/** An illustrative account, priced from the base reserve. */
export const RESERVE_EXAMPLE: readonly ReserveRow[] = [
  { label: COPY.example.minimum, xlm: MINIMUM_BALANCE_RESERVES * BASE_RESERVE_XLM },
  { label: COPY.example.trustlines(4), xlm: 4 * BASE_RESERVE_XLM },
  { label: COPY.example.offers(2), xlm: 2 * BASE_RESERVE_XLM },
  { label: COPY.example.dataAndSigner(1, 1), xlm: 2 * BASE_RESERVE_XLM },
];

export const RESERVE_EXAMPLE_TOTAL = RESERVE_EXAMPLE.reduce((sum, r) => sum + r.xlm, 0);

/** The landing hero's outcome line. It claims DeFi exits only while the registry has them live. */
export function heroOutcome(defi: SiteStatus = feature("defi-exits").status): string {
  return COPY.heroOutcome({
    minimum: MINIMUM_BALANCE_RESERVES * BASE_RESERVE_XLM,
    perItem: BASE_RESERVE_XLM,
    defiLive: defi === "live",
  });
}
