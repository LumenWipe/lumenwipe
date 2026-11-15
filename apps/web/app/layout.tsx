import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Toaster } from "sonner";
import RedactedAnalytics from "@/components/analytics/RedactedAnalytics";
import { UMAMI_BEFORE_SEND, UMAMI_BEFORE_SEND_SCRIPT } from "@/lib/analytics/redact";
import { ROOT_METADATA, ROOT_VIEWPORT } from "@/lib/site/root-metadata";
import { siteFontVars } from "./fonts";
import "./globals.css";

export const viewport: Viewport = ROOT_VIEWPORT;

export const metadata: Metadata = ROOT_METADATA;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <html lang="en" className="dark">
      <head>
        {process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID && (
          <>
            <script
              nonce={nonce}
              suppressHydrationWarning
              dangerouslySetInnerHTML={{ __html: UMAMI_BEFORE_SEND_SCRIPT }}
            />
            <script
              defer
              nonce={nonce}
              suppressHydrationWarning
              src="https://cloud.umami.is/script.js"
              data-website-id={process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID}
              data-exclude-search="true"
              data-exclude-hash="true"
              data-before-send={UMAMI_BEFORE_SEND}
            />
          </>
        )}
      </head>
      <body className={`${siteFontVars} font-body`}>
        <div id="app-root" className="contents">
          {children}
        </div>
        <RedactedAnalytics />
        <Toaster position="bottom-right" theme="dark" richColors />
      </body>
    </html>
  );
}
