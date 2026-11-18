import { formatDate } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/locale";

/** A post date as a reader of `locale` writes it: "November 15, 2026" for "2026-11-15" in English. */
export function formatPostDate(locale: Locale, isoDate: string): string {
  return formatDate(locale, isoDate, {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** "2026-11-15T00:00:00Z" for "2026-11-15": a post date as the UTC timestamp structured data and
 *  Open Graph expect. */
export function postTimestamp(isoDate: string): string {
  return `${isoDate}T00:00:00Z`;
}
