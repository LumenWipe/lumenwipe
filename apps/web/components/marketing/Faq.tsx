import FaqAccordion, { type FaqItem } from "@/components/marketing/FaqAccordion";
import { SITE_LOCALE } from "@/lib/i18n/locale";
import { COMMON } from "@/lib/i18n/messages/common";
import { FAQ } from "@/lib/i18n/messages/faq";
import {
  feature,
  LIVE_EXIT_PROTOCOLS,
  listNames,
  protocolsWithStatus,
  testnetOnlySentence,
} from "@/lib/site/status";
import {
  CHECK_STATEMENT,
  KEY_STATEMENT,
  SERVER_KEYS,
  SERVER_KEYS_INTRO,
  serverKeyScope,
  VERIFY_SOURCE_URL,
} from "@/lib/site/trust";

export const ITEMS: readonly FaqItem[] = FAQ[SITE_LOCALE].items({
  keyStatement: KEY_STATEMENT,
  checkStatement: CHECK_STATEMENT,
  serverKeysIntro: SERVER_KEYS_INTRO,
  serverKeys: SERVER_KEYS.map((key) => ({ ...key, scope: serverKeyScope(key) })),
  verifySourceUrl: VERIFY_SOURCE_URL,
  newTab: COMMON[SITE_LOCALE].newTab,
  exchangeLive: feature("exchange-close").status === "live",
  liveExits: listNames(LIVE_EXIT_PROTOCOLS),
  testnetOnlyExits: listNames(protocolsWithStatus("testnet-only")),
  testnetOnlySentence: testnetOnlySentence(),
});

export default function Faq() {
  return <FaqAccordion items={ITEMS} />;
}
