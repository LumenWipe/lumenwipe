import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import { Toaster } from "sonner";
import { siteFontVars } from "./fonts";
import "./globals.css";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "";

const description =
  "Close your Stellar account safely. Recover locked XLM reserves, remove trustlines, cancel open offers, and exit Soroban DeFi positions in one non-custodial workflow.";

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: "LumenWipe",
  url: APP_URL,
  description,
  applicationCategory: "FinanceApplication",
  operatingSystem: "Web Browser",
  featureList: [
    "Non-custodial Stellar account merge",
    "Trustline removal",
    "Open offer cancellation",
    "Soroban DeFi position exit",
    "XLM reserve recovery",
  ],
};

export const metadata: Metadata = {
  title: {
    default: "LumenWipe - Stellar Account Wind-Down",
    template: "%s | LumenWipe",
  },
  description,
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
  metadataBase: APP_URL ? new URL(APP_URL) : undefined,
  openGraph: {
    title: "LumenWipe - Stellar Account Wind-Down",
    description,
    url: APP_URL,
    siteName: "LumenWipe",
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "LumenWipe - Stellar Account Wind-Down",
    description,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
    },
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <link rel="icon" type="image/png" href="/favicon-96x96.png" sizes="96x96" />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <link rel="shortcut icon" href="/favicon.ico" />
        <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
        <link rel="manifest" href="/site.webmanifest" />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        {process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID && (
          <script
            defer
            src="https://cloud.umami.is/script.js"
            data-website-id={process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID}
          />
        )}
      </head>
      <body className={`${siteFontVars} font-body`}>
        {children}
        <Analytics />
        <Toaster position="bottom-right" theme="dark" richColors />
      </body>
    </html>
  );
}
