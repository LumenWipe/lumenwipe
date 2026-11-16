import type { ReactNode } from "react";
import { Toaster } from "sonner";
import RedactedAnalytics from "@/components/analytics/RedactedAnalytics";
import { UMAMI_BEFORE_SEND, UMAMI_BEFORE_SEND_SCRIPT } from "@/lib/analytics/redact";
import { siteFontVars } from "./fonts";
import "./globals.css";

/**
 * The html and body every root layout renders. App and sign-in routes pass the request's nonce;
 * marketing pages are prerendered without one, and the build hashes their inline scripts instead
 * (scripts/marketing-csp.mjs).
 */
export default function RootDocument({ nonce, children }: { nonce?: string; children: ReactNode }) {
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
