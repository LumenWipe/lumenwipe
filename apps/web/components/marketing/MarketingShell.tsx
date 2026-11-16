import type { ReactNode } from "react";
import MarketingNav from "@/components/marketing/MarketingNav";
import MarketingFooter from "@/components/marketing/MarketingFooter";
import { marketingFontVars } from "@/app/(marketing)/fonts";
import { SITE_LOCALE } from "@/lib/i18n/locale";
import { NAV } from "@/lib/i18n/messages/nav";

export const MAIN_ID = "main";

export default function MarketingShell({ children }: { children: ReactNode }) {
  return (
    <div className={`${marketingFontVars} mkt relative min-h-screen overflow-x-clip bg-canvas`}>
      <a
        href={`#${MAIN_ID}`}
        className="sr-only z-[60] rounded-control bg-accent px-4 py-2 text-sm font-semibold text-accent-fg focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        {NAV[SITE_LOCALE].skipToContent}
      </a>
      {/* atmosphere: film grain + faint top hairline. No grid, no colour aura.
          Absolute (not fixed): a fixed mix-blend-overlay layer blends against the
          white compositor canvas and greys the ink bg; absolute blends against the
          dark wrapper, keeping the exact ink colour. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 z-0">
        <div className="absolute inset-0 mkt-grain" />
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/30 to-transparent" />
      </div>

      <div className="relative z-10 flex min-h-screen flex-col">
        <MarketingNav />
        <main id={MAIN_ID} tabIndex={-1} className="flex-1 outline-none">
          {children}
        </main>
        <MarketingFooter />
      </div>
    </div>
  );
}
