import { cn } from "@/lib/utils/cn";
import type { Network } from "@/config/networks";

interface NetworkBadgeProps {
  network: Network;
  className?: string;
}

export default function NetworkBadge({ network, className }: NetworkBadgeProps) {
  return (
    <span
      className={cn(
        "text-xs px-1.5 py-0.5 rounded font-mono font-medium",
        network === "testnet"
          ? "bg-warning/20 text-warning border border-warning/30"
          : "bg-stellar/10 text-stellar border border-stellar/20",
        className
      )}
    >
      {network === "testnet" ? "TESTNET" : "MAINNET"}
    </span>
  );
}
