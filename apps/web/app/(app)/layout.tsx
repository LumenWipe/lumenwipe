import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import RootDocument from "@/app/root-document";
import { SITE_LOCALE } from "@/lib/i18n/locale";
import { rootMetadata, ROOT_VIEWPORT } from "@/lib/site/root-metadata";

export const viewport: Viewport = ROOT_VIEWPORT;

export const metadata: Metadata = rootMetadata(SITE_LOCALE);

/** The network and sign-in routes: rendered per request, so every script carries the nonce
 *  proxy.ts put in the request. */
export default async function AppRootLayout({ children }: { children: React.ReactNode }) {
  await connection();
  return <RootDocument locale={SITE_LOCALE}>{children}</RootDocument>;
}
