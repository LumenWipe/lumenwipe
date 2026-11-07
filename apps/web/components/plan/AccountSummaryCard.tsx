import { Database, ArrowUpDown, Link2, Users, Layers } from "lucide-react";
import type { AccountState } from "@/types/account";
import type { ExpectedReceive } from "@/lib/plan/expected-receive";
import { formatStroops } from "@/lib/api/plan-adapters";
import { defiVerificationLabel } from "@/lib/plan/defi-verification-source";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";

interface AccountSummaryCardProps {
  account: AccountState;
  destinationAddress: string | null;
  /** Null when no plan estimate is at hand; the counts still render. */
  expected: ExpectedReceive | null;
}

function groupAddress(address: string): string {
  return address.match(/.{1,4}/g)?.join(" ") ?? address;
}

function estimateNote(expected: ExpectedReceive): string {
  const parts = ["An estimate, after network fees."];
  if (expected.estimated) parts.push("It counts the least each chosen swap may deliver.");
  if (expected.unquotedSwaps > 0) {
    parts.push(
      expected.unquotedSwaps === 1
        ? "It leaves out one swap that has no estimate."
        : `It leaves out ${expected.unquotedSwaps} swaps that have no estimate.`
    );
  }
  if (expected.flaggedSwaps > 0) {
    parts.push(
      expected.flaggedSwaps === 1
        ? "One swap you confirmed was flagged on its card: it may deliver much less than the current market price suggests."
        : `${expected.flaggedSwaps} swaps you confirmed were flagged on their cards: they may deliver much less than the current market price suggests.`
    );
  }
  if (expected.tokenSwaps > 0) {
    parts.push("It leaves out the Soroban resource fee each token swap pays.");
  }
  if (expected.leavesOutDefiExits) {
    parts.push(
      "It leaves out any XLM that exiting your DeFi positions pays out, and the fees those exits pay."
    );
  }
  return parts.join(" ");
}

export default function AccountSummaryCard({
  account,
  destinationAddress,
  expected,
}: AccountSummaryCardProps) {
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

  const breakdown = expected
    ? [
        { label: "XLM balance", value: `${formatStroops(expected.balanceStroops)} XLM` },
        { label: "Network fees", value: `- ${formatStroops(expected.feeStroops)} XLM` },
        ...(expected.swapStroops !== "0"
          ? [
              {
                label: "Swaps to XLM, at least",
                value: `+ ${formatStroops(expected.swapStroops)} XLM`,
              },
            ]
          : []),
        ...(expected.claimStroops !== "0"
          ? [{ label: "XLM claimed", value: `+ ${formatStroops(expected.claimStroops)} XLM` }]
          : []),
      ]
    : [];

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex items-center justify-between">
        <CardTitle>Account summary</CardTitle>
        <span className="font-mono-address text-fg-muted text-xs truncate max-w-[200px]">
          {account.address.slice(0, 8)}...{account.address.slice(-8)}
        </span>
      </CardHeader>

      {expected && (
        <div className="px-4 pb-4" data-testid="expected-receive">
          <p className="text-sm text-fg-muted">
            You will receive about{" "}
            <span className="mkt-display block text-3xl font-bold text-value">
              {formatStroops(expected.totalStroops)} XLM
            </span>{" "}
            {destinationAddress ? (
              <>
                at{" "}
                <span className="font-mono-address break-all text-white/70">
                  {groupAddress(destinationAddress)}
                </span>
              </>
            ) : (
              "at the destination you enter below"
            )}
          </p>
          <p className="mt-1 text-xs text-fg-subtle">{estimateNote(expected)}</p>
          <dl className="mt-3 space-y-1 text-xs">
            {breakdown.map(({ label, value }) => (
              <div key={label} className="flex justify-between gap-3">
                <dt className="text-fg-muted">{label}</dt>
                <dd className="mkt-mono text-white/80">{value}</dd>
              </div>
            ))}
            <div className="flex justify-between gap-3 pl-3">
              <dt className="text-fg-subtle">of which locked in reserves</dt>
              <dd className="mkt-mono text-fg-subtle">
                {formatStroops(expected.reserveStroops)} XLM
              </dd>
            </div>
          </dl>
        </div>
      )}

      <ul className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-white/10 px-4 py-3 sm:grid-cols-3">
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
    </Card>
  );
}
