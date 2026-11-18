import MarketingShell from "@/components/marketing/MarketingShell";
import { SITE_LOCALE } from "@/lib/i18n/locale";
import NotFoundView, { NOT_FOUND_METADATA } from "@/components/marketing/NotFoundView";

export const metadata = NOT_FOUND_METADATA;

export default function NotFound() {
  return (
    <MarketingShell locale={SITE_LOCALE}>
      <NotFoundView />
    </MarketingShell>
  );
}
