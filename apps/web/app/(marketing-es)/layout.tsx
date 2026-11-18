import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import RootDocument from "@/app/root-document";
import MarketingShell from "@/components/marketing/MarketingShell";
import { rootMetadata, ROOT_VIEWPORT } from "@/lib/site/root-metadata";

export const viewport: Viewport = ROOT_VIEWPORT;

export const metadata: Metadata = rootMetadata("es");

/** The Spanish pages' root layout: the same document as (marketing), in Spanish, and prerendered
 *  for the same reason (docs/contributing/localization.mdx). */
export default function SpanishMarketingLayout({ children }: { children: ReactNode }) {
  return (
    <RootDocument locale="es">
      <MarketingShell locale="es">{children}</MarketingShell>
    </RootDocument>
  );
}
