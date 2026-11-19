import registry from "@registry/contract-registry.json";
import { formatDate } from "@/lib/i18n/format";
import { SITE_LOCALE, type Locale } from "@/lib/i18n/locale";
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

const RESERVE_SOURCE_HREF =
  "https://developers.stellar.org/docs/learn/fundamentals/lumens#minimum-balance";
const RESERVE_SOURCE_AS_OF = "2026-11-14";

const REGISTRY_FILE = "apps/api/src/config/contract-registry.json";

/** "Nov 2026" for "2026-11-14". */
export function monthYear(isoDate: string, locale: Locale = SITE_LOCALE): string {
  return formatDate(locale, `${isoDate}T00:00:00Z`, {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** The landing's stat band, worded for a reader of `locale`. */
export function siteStats(locale: Locale): readonly SiteStat[] {
  const copy = SITE[locale].numbers;
  return [
    {
      value: copy.reserveValue(MINIMUM_BALANCE_RESERVES * BASE_RESERVE_XLM, BASE_RESERVE_XLM),
      label: copy.reserveLabel,
      source: {
        kind: "external",
        href: RESERVE_SOURCE_HREF,
        label: copy.reserveSource,
        asOf: RESERVE_SOURCE_AS_OF,
      },
    },
    {
      value: String(LIVE_EXIT_PROTOCOLS.length),
      label: copy.liveExitsLabel,
      source: { kind: "registry", file: REGISTRY_FILE },
    },
    {
      value: monthYear(registry.lastVerified, locale),
      label: copy.lastVerifiedLabel,
      source: { kind: "registry", file: REGISTRY_FILE },
    },
  ];
}

export const STATS: readonly SiteStat[] = siteStats(SITE_LOCALE);

export interface ReserveRow {
  label: string;
  xlm: number;
}

/** An illustrative account, priced from the base reserve, labelled for a reader of `locale`. */
export function reserveExample(locale: Locale): readonly ReserveRow[] {
  const example = SITE[locale].numbers.example;
  return [
    { label: example.minimum, xlm: MINIMUM_BALANCE_RESERVES * BASE_RESERVE_XLM },
    { label: example.trustlines(4), xlm: 4 * BASE_RESERVE_XLM },
    { label: example.offers(2), xlm: 2 * BASE_RESERVE_XLM },
    { label: example.dataAndSigner(1, 1), xlm: 2 * BASE_RESERVE_XLM },
  ];
}

export const RESERVE_EXAMPLE: readonly ReserveRow[] = reserveExample(SITE_LOCALE);

export const RESERVE_EXAMPLE_TOTAL = RESERVE_EXAMPLE.reduce((sum, r) => sum + r.xlm, 0);

/** The landing hero's outcome line. It claims DeFi exits only while the registry has them live. */
export function heroOutcome(
  defi: SiteStatus = feature("defi-exits").status,
  locale: Locale = SITE_LOCALE
): string {
  return SITE[locale].numbers.heroOutcome({
    minimum: MINIMUM_BALANCE_RESERVES * BASE_RESERVE_XLM,
    perItem: BASE_RESERVE_XLM,
    defiLive: defi === "live",
  });
}
