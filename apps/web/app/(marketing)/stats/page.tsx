import type { Metadata } from "next";
import { SITE_LOCALE } from "@/lib/i18n/locale";
import { STATS_PAGE } from "@/lib/i18n/messages/stats";
import { pageMetadata } from "@/lib/site/pages";
import StatsClient from "@/components/marketing/stats/StatsClient";

export const metadata: Metadata = pageMetadata({
  path: "/stats",
  title: STATS_PAGE[SITE_LOCALE].metadata.title,
  description: STATS_PAGE[SITE_LOCALE].metadata.description,
});

export default function StatsPage() {
  return <StatsClient />;
}
