import type { ReactNode } from "react";
import MarketingNav from "@/components/marketing/MarketingNav";
import MarketingFooter from "@/components/marketing/MarketingFooter";
import { marketingFontVars } from "./fonts";

export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <div
      className={`${marketingFontVars} mkt relative min-h-screen overflow-x-clip bg-[hsl(var(--mkt-bg))]`}
    >
      {/* atmosphere: film grain + faint top hairline. No grid, no colour aura.
          Absolute (not fixed): a fixed mix-blend-overlay layer blends against the
          white compositor canvas and greys the ink bg; absolute blends against the
          dark wrapper, keeping the exact ink colour. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 z-0">
        <div className="absolute inset-0 mkt-grain" />
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-stellar/30 to-transparent" />
      </div>

      <div className="relative z-10 flex min-h-screen flex-col">
        <MarketingNav />
        <main className="flex-1">{children}</main>
        <MarketingFooter />
      </div>
    </div>
  );
}
