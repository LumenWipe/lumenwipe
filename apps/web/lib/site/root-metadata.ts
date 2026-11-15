import type { Metadata, Viewport } from "next";
import { INK } from "@/brand/tokens";
import { SHARE_IMAGE, SITE_NAME } from "@/lib/site/pages";
import { siteOrigin } from "@/lib/site/url";

export const SITE_DESCRIPTION =
  "Close your Stellar account safely. Recover locked XLM reserves, remove trustlines, cancel open offers, and exit Soroban DeFi positions in one non-custodial workflow.";

/** The root layout's viewport: the browser chrome takes the ink. */
export const ROOT_VIEWPORT: Viewport = {
  themeColor: INK,
  colorScheme: "dark",
};

/** What every page inherits unless it sets its own: the brand title template, the share image,
 *  the icons and the manifest. */
export const ROOT_METADATA: Metadata = {
  title: {
    default: "LumenWipe - Close a Stellar Account",
    template: "%s | LumenWipe",
  },
  description: SITE_DESCRIPTION,
  keywords: [
    "Stellar",
    "XLM",
    "Lumens",
    "account merge",
    "non-custodial",
    "Soroban",
    "DeFi",
    "trustline",
    "blockchain",
    "LumenWipe",
  ],
  metadataBase: new URL(siteOrigin()),
  openGraph: {
    title: "LumenWipe - Close a Stellar Account",
    description: SITE_DESCRIPTION,
    siteName: SITE_NAME,
    type: "website",
    locale: "en_US",
    images: [SHARE_IMAGE],
  },
  twitter: {
    card: "summary_large_image",
    title: "LumenWipe - Close a Stellar Account",
    description: SITE_DESCRIPTION,
    images: [SHARE_IMAGE],
  },
  icons: {
    icon: [
      { url: "/favicon-96x96.png", type: "image/png", sizes: "96x96" },
      { url: "/favicon.svg", type: "image/svg+xml" },
    ],
    shortcut: "/favicon.ico",
    apple: { url: "/apple-touch-icon.png", sizes: "180x180" },
  },
  manifest: "/site.webmanifest",
};
