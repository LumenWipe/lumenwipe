import type { Metadata } from "next";
import Link from "next/link";
import { Home, ArrowRight, GitMerge } from "lucide-react";
import Logo from "@/components/marketing/Logo";

export const metadata: Metadata = {
  title: "404 - Page Not Found",
  description: "This page doesn't exist on the ledger.",
};

const STEPS = [
  { label: "Resolving route", ok: true },
  { label: "Querying ledger state", ok: true },
  { label: "Account found", ok: false },
];

const STATS = [
  { label: "Subentries", value: "0" },
  { label: "XLM balance", value: "0.0000000" },
  { label: "Status", value: "MERGED" },
];

export default function NotFound() {
  return (
    <div className="mkt relative min-h-screen overflow-x-clip bg-[#07070b] flex flex-col">
      {/* ambient */}
      <div aria-hidden className="pointer-events-none fixed inset-0 z-0">
        <div className="absolute inset-0 mkt-grid opacity-30" />
        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(55% 45% at 50% 38%, hsl(196 100% 47% / 0.09), transparent 70%)",
          }}
        />
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-stellar/30 to-transparent" />
      </div>

      {/* minimal header */}
      <header className="relative z-10 border-b border-white/[0.07]">
        <div className="mx-auto flex h-16 max-w-5xl items-center px-5 lg:px-8">
          <Link href="/" aria-label="LumenWipe home">
            <Logo />
          </Link>
        </div>
      </header>

      {/* main */}
      <main className="relative z-10 flex flex-1 items-center justify-center px-5 py-20">
        <div className="w-full max-w-md">
          {/* eyebrow */}
          <p className="mkt-eyebrow mb-7 text-stellar/50">ledger lookup · error_code: 404</p>

          {/* terminal panel */}
          <div className="mb-9 overflow-hidden rounded-2xl border border-white/[0.09] bg-[#0a0a10]/80 backdrop-blur-sm">
            {/* title bar */}
            <div className="flex items-center gap-1.5 border-b border-white/[0.07] bg-white/[0.02] px-4 py-3">
              <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]/70" />
              <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]/70" />
              <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]/30" />
              <span className="mkt-mono ml-3 text-xs text-white/20">
                lumenwipe · account-lookup
              </span>
            </div>

            {/* terminal body */}
            <div className="space-y-4 px-5 py-5">
              {/* command */}
              <div className="mkt-mono text-sm">
                <span className="text-stellar/40">$ </span>
                <span className="text-white/50">lw analyze --network mainnet </span>
                <span className="text-value/70">this-page</span>
              </div>

              {/* step checklist */}
              <ul className="mkt-mono space-y-2 text-sm">
                {STEPS.map((s) => (
                  <li key={s.label} className="flex items-center gap-3">
                    <span className={s.ok ? "text-stellar" : "text-red-400"}>
                      {s.ok ? "✓" : "✗"}
                    </span>
                    <span className={s.ok ? "text-white/40" : "text-red-400/75"}>
                      {s.label}
                      {!s.ok && " - account_not_found"}
                    </span>
                  </li>
                ))}
              </ul>

              {/* divider + stats */}
              <div className="border-t border-white/[0.07] pt-4">
                <div className="grid grid-cols-3 gap-2 text-center">
                  {STATS.map((s) => (
                    <div key={s.label}>
                      <div
                        className={`mkt-mono text-base font-semibold ${
                          s.label === "Status" ? "text-stellar/40" : "text-white/20"
                        }`}
                      >
                        {s.value}
                      </div>
                      <div className="mkt-eyebrow mt-1 text-white/20">{s.label}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* result line */}
              <div className="mkt-mono rounded-lg border border-stellar/10 bg-stellar/[0.04] px-3 py-2.5 text-xs text-stellar/50">
                <span className="text-stellar/30">info </span>
                This account was merged out. Nothing remains on the ledger.
              </div>
            </div>
          </div>

          {/* headline */}
          <h1 className="mkt-display mb-3 text-[2.6rem] font-bold leading-[1] text-white">
            This page has
            <br />
            been wiped.
          </h1>
          <p className="mb-8 text-[0.95rem] leading-relaxed text-white/45">
            No trustlines. No balance. No subentries.
            <br />
            Looks like this route was already merged out.
          </p>

          {/* CTAs */}
          <div className="flex flex-wrap gap-3">
            <Link
              href="/"
              className="inline-flex items-center gap-2 rounded-xl bg-stellar px-5 py-2.5 text-sm font-semibold text-black transition-all hover:bg-stellar/90 hover:shadow-[0_0_24px_-4px_hsl(var(--stellar)/0.5)]"
            >
              <Home className="h-4 w-4" />
              Back to home
            </Link>
            <Link
              href="/mainnet"
              className="inline-flex items-center gap-2 rounded-xl border border-white/10 px-5 py-2.5 text-sm font-medium text-white/60 transition-colors hover:border-white/20 hover:text-white"
            >
              <GitMerge className="h-4 w-4" />
              Open the app
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
