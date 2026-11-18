import type { ReactNode } from "react";
import { Toaster } from "sonner";
import RedactedAnalytics from "@/components/analytics/RedactedAnalytics";
import { LOCALE_TAGS, type Locale } from "@/lib/i18n/locale";
import { siteFontVars } from "./fonts";
import "./globals.css";

/**
 * The html and body every root layout renders. App and sign-in routes are rendered per request,
 * so Next gives their scripts the request's nonce; marketing pages are prerendered without one,
 * and the build hashes their inline scripts instead (scripts/marketing-csp.mjs).
 */
export default function RootDocument({
  locale,
  children,
}: {
  locale: Locale;
  children: ReactNode;
}) {
  return (
    <html lang={LOCALE_TAGS[locale].html} className="dark">
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
