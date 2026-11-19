import FaqAccordion, { type FaqItem } from "@/components/marketing/FaqAccordion";
import { formatNumber } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/locale";
import { COMMON } from "@/lib/i18n/messages/common";
import { FAQ } from "@/lib/i18n/messages/faq";
import { BASE_RESERVE_XLM, MINIMUM_BALANCE_RESERVES } from "@/lib/site/reserve";
import {
  feature,
  LIVE_EXIT_PROTOCOLS,
  listNames,
  protocolsWithStatus,
  testnetOnlySentence,
} from "@/lib/site/status";
import { serverKeys, serverKeyScope, trustStatements, VERIFY_SOURCE_URL } from "@/lib/site/trust";

/** The FAQ items in `locale`, built from the registry facts, the trust statements and the
 *  network's reserve. */
export function faqItems(locale: Locale): readonly FaqItem[] {
  const trust = trustStatements(locale);
  return FAQ[locale].items({
    keyStatement: trust.key,
    checkStatement: trust.check,
    serverKeysIntro: trust.serverKeysIntro,
    serverKeys: serverKeys(locale).map((key) => ({ ...key, scope: serverKeyScope(key, locale) })),
    verifySourceUrl: VERIFY_SOURCE_URL,
    newTab: COMMON[locale].newTab,
    exchangeLive: feature("exchange-close").status === "live",
    liveExits: listNames(LIVE_EXIT_PROTOCOLS, locale),
    testnetOnlyExits: listNames(protocolsWithStatus("testnet-only"), locale),
    testnetOnlySentence: testnetOnlySentence(locale),
    minimumBalance: formatNumber(locale, MINIMUM_BALANCE_RESERVES * BASE_RESERVE_XLM),
    perItem: formatNumber(locale, BASE_RESERVE_XLM),
  });
}

export default function Faq({ locale }: { locale: Locale }) {
  return <FaqAccordion items={faqItems(locale)} />;
}
