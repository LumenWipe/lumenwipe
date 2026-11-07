import { cn } from "@/lib/utils/cn";
import type { Network } from "@/config/networks";
import { Badge } from "@/components/ui/badge";

interface NetworkBadgeProps {
  network: Network;
  /** Says what the network's funds are, for a screen where that decides what is at stake. */
  detailed?: boolean;
  className?: string;
}

/** The network's name as the app says it wherever a mistaken network would cost real funds. */
export const NETWORK_NAME: Record<Network, string> = {
  mainnet: "MAINNET",
  testnet: "TESTNET",
};

const DETAIL: Record<Network, string> = {
  mainnet: "MAINNET: real funds",
  testnet: "TESTNET: no real value",
};

export default function NetworkBadge({ network, detailed = false, className }: NetworkBadgeProps) {
  return (
    <Badge
      tone={network === "testnet" ? "warning" : "accent"}
      className={cn("font-mono", className)}
    >
      {detailed ? DETAIL[network] : NETWORK_NAME[network]}
    </Badge>
  );
}
