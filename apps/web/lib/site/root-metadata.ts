import type { Metadata, Viewport } from "next";
import { INK } from "@/brand/tokens";
import { LOCALE_TAGS, type Locale } from "@/lib/i18n/locale";
import { SITE } from "@/lib/i18n/messages/site";
import { SHARE_IMAGE, SITE_NAME } from "@/lib/site/pages";
import { siteOrigin } from "@/lib/site/url";

/** The root layout's viewport: the browser chrome takes the ink. */
export const ROOT_VIEWPORT: Viewport = {
  themeColor: INK,
  colorScheme: "dark",
};

/** What every page of a root layout in `locale` inherits unless it sets its own: the brand title
 *  template, the share image, the icons and the manifest. */
export function rootMetadata(locale: Locale): Metadata {
  const COPY = SITE[locale].metadata;
  return {
    title: {
      default: COPY.defaultTitle,
      template: "%s | LumenWipe",
    },
    description: COPY.description,
    keywords: COPY.keywords,
    metadataBase: new URL(siteOrigin()),
    openGraph: {
      title: COPY.defaultTitle,
      description: COPY.description,
      siteName: SITE_NAME,
      type: "website",
      locale: LOCALE_TAGS[locale].openGraph,
      images: [SHARE_IMAGE],
    },
    twitter: {
      card: "summary_large_image",
      title: COPY.defaultTitle,
      description: COPY.description,
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
}
