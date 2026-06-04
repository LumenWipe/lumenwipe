"use client";

import { useState } from "react";
import Link from "next/link";
import { History } from "lucide-react";
import type { Network } from "@/config/networks";
import Logo from "@/components/marketing/Logo";
import NetworkSwitcher from "./NetworkSwitcher";
import NetworkBadge from "./NetworkBadge";
import HistoryPanel from "@/components/history/HistoryPanel";

interface NavBarProps {
  network: Network;
}

export default function NavBar({ network }: NavBarProps) {
  const [historyOpen, setHistoryOpen] = useState(false);

  return (
    <>
      <header className="sticky top-0 z-50 border-b border-white/10 bg-[#08080c]/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <Link href="/" aria-label="LumenWipe home" className="shrink-0">
              <Logo />
            </Link>
            <span className="hidden h-4 w-px bg-white/10 sm:block" />
            <NetworkBadge network={network} className="hidden sm:inline-flex" />
          </div>

          <div className="flex items-center gap-2 sm:gap-4">
            <Link
              href="/how-it-works"
              className="hidden text-sm text-white/65 transition-colors hover:text-white sm:block"
            >
              How it works
            </Link>
            <Link
              href="/blog"
              className="hidden text-sm text-white/65 transition-colors hover:text-white sm:block"
            >
              Blog
            </Link>
            <button
              onClick={() => setHistoryOpen(true)}
              title="Merge history"
              aria-label="Merge history"
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 text-white/65 transition-colors hover:border-white/20 hover:text-white"
            >
              <History className="h-4 w-4" />
            </button>
            <NetworkSwitcher currentNetwork={network} />
          </div>
        </div>
      </header>

      {historyOpen && <HistoryPanel onClose={() => setHistoryOpen(false)} />}
    </>
  );
}
