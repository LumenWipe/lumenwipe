"use client";

import Link from "next/link";
import { cn } from "@/lib/utils/cn";
import type { Network } from "@/config/networks";

interface NetworkSwitcherProps {
  currentNetwork: Network;
}

export default function NetworkSwitcher({ currentNetwork }: NetworkSwitcherProps) {
  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-white/10 bg-white/[0.03] p-0.5 text-xs">
      {(["mainnet", "testnet"] as Network[]).map((net) => (
        <Link
          key={net}
          href={`/${net}`}
          className={cn(
            "rounded-md px-2.5 py-1 font-medium transition-colors",
            currentNetwork === net ? "bg-white/10 text-white" : "text-white/55 hover:text-white"
          )}
        >
          {net === "mainnet" ? "Mainnet" : "Testnet"}
        </Link>
      ))}
    </div>
  );
}
