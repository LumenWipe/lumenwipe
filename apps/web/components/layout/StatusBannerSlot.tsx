import StatusBanner from "@/components/layout/StatusBanner";
import type { Locale } from "@/lib/i18n/locale";
import { statusSource } from "@/lib/status/source";

/**
 * Mounts the status banner only while a status source is configured, so without one a page
 * carries no banner and makes no status request. Prerendered pages decide this at build time.
 */
export default function StatusBannerSlot({ locale }: { locale: Locale }) {
  return statusSource() ? <StatusBanner locale={locale} /> : null;
}
