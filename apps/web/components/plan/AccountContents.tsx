import { Database, ArrowUpDown, Link2, Users, Layers } from "lucide-react";
import type { AccountState } from "@/types/account";
import { defiVerificationLabel } from "@/lib/plan/defi-verification-source";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils/cn";

interface AccountContentsProps {
  account: AccountState;
  className?: string;
}

/** What the account holds, as counts. */
export default function AccountContents({ account, className }: AccountContentsProps) {
  const defiLabel = defiVerificationLabel(account.defiPositions.source);

  const stats = [
    { icon: Link2, label: "Trustlines", value: account.trustlines.length },
    { icon: ArrowUpDown, label: "Open offers", value: account.openOffers.length },
    { icon: Database, label: "Data entries", value: account.dataEntries.length },
    {
      icon: Users,
      label: "Extra signers",
      value: account.signers.filter((s) => s.key !== account.address).length,
    },
    {
      icon: Layers,
      label: "DeFi positions",
      value: account.defiPositions.positions.length,
      badge: defiLabel,
    },
  ];

  return (
    <ul className={cn("grid grid-cols-2 gap-x-4 gap-y-2 px-4 py-3 sm:grid-cols-3", className)}>
      {stats.map(({ icon: Icon, label, value, badge }) => (
        <li key={label} className="min-w-0 text-xs text-fg-subtle">
          <span className="flex items-center gap-1.5">
            <Icon className="h-3.5 w-3.5 shrink-0 text-accent/70" aria-hidden />
            <span className="truncate">{label}</span>
            <span className="ml-auto font-semibold text-white/80">{value}</span>
          </span>
          {badge && (
            <Badge tone={badge === "octopos" ? "accent" : "neutral"} className="mt-1">
              {badge === "octopos" ? "Verified with OctoPos" : "Verified by LumenWipe"}
            </Badge>
          )}
        </li>
      ))}
    </ul>
  );
}
