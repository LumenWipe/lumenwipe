import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import RootDocument from "@/app/root-document";
import { ROOT_METADATA, ROOT_VIEWPORT } from "@/lib/site/root-metadata";

export const viewport: Viewport = ROOT_VIEWPORT;

export const metadata: Metadata = ROOT_METADATA;

/** The network and sign-in routes: rendered per request, so every script carries the nonce
 *  proxy.ts put in the request. */
export default async function AppRootLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return <RootDocument nonce={nonce}>{children}</RootDocument>;
}
