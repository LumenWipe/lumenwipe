import { cn } from "@/lib/utils/cn";
import type { Network } from "@/config/networks";
import { Badge } from "@/components/ui/badge";

interface NetworkBadgeProps {
  network: Network;
  className?: string;
}

export default function NetworkBadge({ network, className }: NetworkBadgeProps) {
  return (
    <Badge
      tone={network === "testnet" ? "warning" : "accent"}
      className={cn("font-mono", className)}
    >
      {network === "testnet" ? "TESTNET" : "MAINNET"}
    </Badge>
  );
}
