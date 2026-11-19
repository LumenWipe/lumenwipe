import { formatPostDate } from "@/lib/blog-date";
import { formatNumber } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/locale";
import { BASE_RESERVE_CHECKED_ON, BASE_RESERVE_XLM } from "@/lib/site/reserve";

/** The MDX components a post in `locale` states the base reserve with, so no post copies the
 *  number or the day it was checked. */
export function baseReserveComponents(locale: Locale) {
  return {
    BaseReserve: () => <>{formatNumber(locale, BASE_RESERVE_XLM)} XLM</>,
    BaseReserveCheckedOn: () => (
      <time dateTime={BASE_RESERVE_CHECKED_ON}>
        {formatPostDate(locale, BASE_RESERVE_CHECKED_ON)}
      </time>
    ),
  };
}
