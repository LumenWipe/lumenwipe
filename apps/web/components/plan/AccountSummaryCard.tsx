import type { AccountState } from "@/types/account";
import type { ExpectedReceive } from "@/lib/plan/expected-receive";
import { formatStroops } from "@/lib/api/plan-adapters";
import AccountContents from "@/components/plan/AccountContents";
import { ExpectedReceiveBreakdown, estimateNote } from "@/components/plan/ExpectedReceiveBreakdown";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { FullAddress } from "@/components/ui/full-address";

interface AccountSummaryCardProps {
  account: AccountState;
  destinationAddress: string | null;
  /** Null when no plan estimate is at hand; the counts still render. */
  expected: ExpectedReceive | null;
}

export default function AccountSummaryCard({
  account,
  destinationAddress,
  expected,
}: AccountSummaryCardProps) {
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
                <FullAddress
                  value={destinationAddress}
                  label="destination address"
                  className="text-white/70"
                />
              </>
            ) : (
              "at the destination you enter below"
            )}
          </p>
          <p className="mt-1 text-xs text-fg-subtle">{estimateNote(expected)}</p>
          <div className="mt-3">
            <ExpectedReceiveBreakdown expected={expected} />
          </div>
        </div>
      )}

      <AccountContents account={account} className="border-t border-white/10" />
    </Card>
  );
}
