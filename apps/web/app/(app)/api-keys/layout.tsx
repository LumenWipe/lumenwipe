import type { ReactNode } from "react";
import MarketingShell from "@/components/marketing/MarketingShell";
import { SITE_LOCALE } from "@/lib/i18n/locale";

/** A sign-in route, so it renders under the nonce policy, in the marketing site's frame. */
export default function ApiKeysLayout({ children }: { children: ReactNode }) {
  return <MarketingShell locale={SITE_LOCALE}>{children}</MarketingShell>;
}
