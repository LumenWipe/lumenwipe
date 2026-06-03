"use client";

import { useState } from "react";
import Link from "next/link";
import { Zap, History } from "lucide-react";
import type { Network } from "@/config/networks";
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
      <header className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-sm">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
          <Link
            href={`/${network}`}
            className="flex items-center gap-2 text-foreground hover:text-stellar transition-colors"
          >
            <Zap className="h-5 w-5 text-stellar" />
            <span className="font-semibold text-sm tracking-tight">Account Demolisher</span>
            <NetworkBadge network={network} />
          </Link>

          <div className="flex items-center gap-3">
            <Link
              href="/blog"
              className="text-xs text-muted-foreground hover:text-foreground transition-colors hidden sm:block"
            >
              Blog
            </Link>
            <button
              onClick={() => setHistoryOpen(true)}
              title="Merge history"
              className="text-muted-foreground hover:text-foreground transition-colors"
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
