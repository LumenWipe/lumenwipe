import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import RootDocument from "@/app/root-document";
import { SITE_LOCALE } from "@/lib/i18n/locale";
import MarketingShell from "@/components/marketing/MarketingShell";
import NotFoundView, { NOT_FOUND_METADATA } from "@/components/marketing/NotFoundView";
import { ROOT_METADATA, ROOT_VIEWPORT } from "@/lib/site/root-metadata";

export const viewport: Viewport = ROOT_VIEWPORT;

export const metadata: Metadata = { ...ROOT_METADATA, ...NOT_FOUND_METADATA };

/** Unmatched URLs, under either root layout. Rendered per request so its scripts carry the
 *  nonce of the policy proxy.ts sends with it. */
export default async function GlobalNotFound() {
  await connection();
  return (
    <RootDocument locale={SITE_LOCALE}>
      <MarketingShell>
        <NotFoundView />
      </MarketingShell>
    </RootDocument>
  );
}
