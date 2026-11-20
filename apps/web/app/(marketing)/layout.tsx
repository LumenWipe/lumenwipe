import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import RootDocument from "@/app/root-document";
import { SITE_LOCALE } from "@/lib/i18n/locale";
import UmamiAnalytics from "@/components/analytics/UmamiAnalytics";
import MarketingShell from "@/components/marketing/MarketingShell";
import { rootMetadata, ROOT_VIEWPORT } from "@/lib/site/root-metadata";

export const viewport: Viewport = ROOT_VIEWPORT;

export const metadata: Metadata = rootMetadata(SITE_LOCALE);

/** A root layout of its own, reading no request data, so every marketing page is prerendered. */
export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <RootDocument locale={SITE_LOCALE}>
      <UmamiAnalytics />
      <MarketingShell locale={SITE_LOCALE}>{children}</MarketingShell>
    </RootDocument>
  );
}
