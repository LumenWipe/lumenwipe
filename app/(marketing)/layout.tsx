import type { ReactNode } from "react";
import MarketingNav from "@/components/marketing/MarketingNav";
import MarketingFooter from "@/components/marketing/MarketingFooter";
import { marketingFontVars } from "./fonts";

export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <div className={`${marketingFontVars} mkt relative min-h-screen overflow-x-clip bg-[#07070b]`}>
      {/* ambient blueprint + aura, fixed so it stays put while scrolling */}
      <div aria-hidden className="pointer-events-none fixed inset-0 z-0">
        <div className="absolute inset-0 mkt-grid opacity-70" />
        <div className="absolute inset-0 mkt-aura" />
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-stellar/40 to-transparent" />
      </div>

      <div className="relative z-10 flex min-h-screen flex-col">
        <MarketingNav />
        <main className="flex-1">{children}</main>
        <MarketingFooter />
      </div>
    </div>
  );
}
