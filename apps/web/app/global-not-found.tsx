import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import { headers } from "next/headers";
import RootDocument from "@/app/root-document";
import { LOCALE_HEADER, localeFromHeader, type Locale } from "@/lib/i18n/locale";
import MarketingShell from "@/components/marketing/MarketingShell";
import NotFoundView, { notFoundMetadata } from "@/components/marketing/NotFoundView";
import { rootMetadata, ROOT_VIEWPORT } from "@/lib/site/root-metadata";

export const viewport: Viewport = ROOT_VIEWPORT;

/** The locale proxy.ts read from the requested path: Spanish under /es, else English. */
async function requestLocale(): Promise<Locale> {
  return localeFromHeader((await headers()).get(LOCALE_HEADER));
}

export async function generateMetadata(): Promise<Metadata> {
  const locale = await requestLocale();
  return { ...rootMetadata(locale), ...notFoundMetadata(locale) };
}

/** Unmatched URLs, under either root layout, in the language of the path. Rendered per request so
 *  its scripts carry the nonce of the policy proxy.ts sends with it. */
export default async function GlobalNotFound() {
  await connection();
  const locale = await requestLocale();
  return (
    <RootDocument locale={locale}>
      <MarketingShell locale={locale}>
        <NotFoundView locale={locale} />
      </MarketingShell>
    </RootDocument>
  );
}
