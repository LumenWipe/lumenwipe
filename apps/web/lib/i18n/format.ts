import { LOCALE_TAGS, type Locale } from "@/lib/i18n/locale";

/** A number as a reader of `locale` writes it. */
export function formatNumber(
  locale: Locale,
  value: number,
  options?: Intl.NumberFormatOptions
): string {
  return new Intl.NumberFormat(LOCALE_TAGS[locale].intl, options).format(value);
}

/** A date or time as a reader of `locale` writes it, in the fields `options` names. */
export function formatDate(
  locale: Locale,
  value: Date | string | number,
  options: Intl.DateTimeFormatOptions
): string {
  return new Intl.DateTimeFormat(LOCALE_TAGS[locale].intl, options).format(new Date(value));
}

/** Two decimal places, the way amounts of XLM are shown. */
export const TWO_DECIMALS: Intl.NumberFormatOptions = {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
};
