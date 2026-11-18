import type { Metadata } from "next";
import { LANDING } from "@/lib/i18n/messages/landing";
import { SITE } from "@/lib/i18n/messages/site";
import { localePath, pageMetadata } from "@/lib/site/pages";
import { feature } from "@/lib/site/status";

export { default } from "@/app/(marketing)/page";

export const metadata: Metadata = pageMetadata({
  path: localePath("es", "/"),
  locale: "es",
  title: SITE.es.metadata.homeTitle,
  description: LANDING.es.description(feature("exchange-close").status === "live"),
});
