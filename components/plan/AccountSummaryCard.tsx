import { Coins, Database, ArrowUpDown, Link2, Users, TrendingUp } from "lucide-react";
import type { AccountState } from "@/types/account";
import { formatXlm, calcRecoverableReserve } from "@/lib/utils/amounts";

interface AccountSummaryCardProps {
  account: AccountState;
  destinationAddress: string;
  totalFee: string;
}

export default function AccountSummaryCard({
  account,
  destinationAddress,
  totalFee,
}: AccountSummaryCardProps) {
  const recoverableXlm = calcRecoverableReserve(account.numSubEntries);
  // Whether direct or via the shared mediator, the user recovers the full
  // balance minus network fees (the mediator's own reserve is operator-funded).
  const estimatedFinal = (parseFloat(account.nativeBalanceLumens) - parseFloat(totalFee)).toFixed(
    7
  );

  const stats = [
    {
      icon: Coins,
      label: "XLM balance",
      value: formatXlm(account.nativeBalanceLumens),
    },
    {
      icon: Database,
      label: "Data entries",
      value: account.dataEntries.length,
    },
    {
      icon: ArrowUpDown,
      label: "Open offers",
      value: account.openOffers.length,
    },
    {
      icon: Link2,
      label: "Trustlines",
      value: account.trustlines.length,
    },
    {
      icon: Users,
      label: "Extra signers",
      value: account.signers.filter((s) => s.key !== account.address).length,
    },
    {
      icon: TrendingUp,
      label: "Recoverable reserve",
      value: formatXlm(recoverableXlm),
    },
  ];

  return (
    <div className="mkt-panel rounded-2xl overflow-hidden">
      <div className="border-b border-white/10 px-4 py-3 flex items-center justify-between">
        <h3 className="mkt-eyebrow text-white/45">Account summary</h3>
        <span className="font-mono-address text-white/55 text-xs truncate max-w-[200px]">
          {account.address.slice(0, 8)}...{account.address.slice(-8)}
        </span>
      </div>

      <div className="grid grid-cols-3 divide-x divide-y divide-white/8">
        {stats.map(({ icon: Icon, label, value }) => (
          <div key={label} className="p-3">
            <div className="flex items-center gap-1.5 text-white/45 mb-1">
              <Icon className="h-3.5 w-3.5 text-stellar/70" />
              <span className="text-xs">{label}</span>
            </div>
            <p className="text-sm font-semibold text-white">{value}</p>
          </div>
        ))}
      </div>

      <div className="border-t border-white/10 px-4 py-3 flex items-center justify-between text-sm">
        <span className="text-white/55">Estimated received at destination</span>
        <span className="mkt-display font-bold text-value">{formatXlm(estimatedFinal)}</span>
      </div>

      <div className="border-t border-white/10 px-4 py-2 text-xs text-white/45">
        Destination:{" "}
        <span className="font-mono-address text-white/60">
          {destinationAddress.slice(0, 12)}...{destinationAddress.slice(-8)}
        </span>
      </div>
    </div>
  );
}
