"use client";

import { cn } from "@/lib/utils/cn";
import type { Network } from "@/config/networks";
import { LeaveLink } from "./LeaveGuard";

interface NetworkSwitcherProps {
  currentNetwork: Network;
}

export default function NetworkSwitcher({ currentNetwork }: NetworkSwitcherProps) {
  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-white/10 bg-white/[0.03] p-0.5 text-xs">
      {(["mainnet", "testnet"] as Network[]).map((net) => (
        <LeaveLink
          key={net}
          href={`/${net}`}
          aria-current={currentNetwork === net ? "true" : undefined}
          className={cn(
            "rounded-md px-2.5 py-1 font-medium transition-colors",
            currentNetwork === net ? "bg-white/10 text-white" : "text-fg-muted hover:text-white"
          )}
        >
          {net === "mainnet" ? "Mainnet" : "Testnet"}
        </LeaveLink>
      ))}
    </div>
  );
}
