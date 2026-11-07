import type { ReactNode } from "react";
import type { AssetOutcome } from "@/lib/plan/asset-outcomes";
import type { ExpectedReceive } from "@/lib/plan/expected-receive";
import { formatStroops } from "@/lib/api/plan-adapters";
import {
  ExpectedReceiveBreakdown,
  FEES_EXCEED_BALANCE,
  estimateNote,
  receiveFigure,
} from "@/components/plan/ExpectedReceiveBreakdown";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { FullAddress } from "@/components/ui/full-address";
import { Callout } from "@/components/ui/callout";

interface AssetOutcomeTableProps {
  rows: AssetOutcome[];
  /** Null when the amount cannot be estimated: no usable plan fee, or a step fee that cannot be
   *  read. The rows still render. */
  expected: ExpectedReceive | null;
}

function holding(row: AssetOutcome): string {
  return row.amount === null ? row.code : `${row.amount} ${row.code}`;
}

function outcome(row: AssetOutcome): ReactNode {
  switch (row.action) {
    case "convert":
      return row.minimumStroops === null
        ? "Swapped to XLM: minimum not available, so the estimate below counts nothing for it."
        : `Swapped to XLM: you receive at least ${formatStroops(row.minimumStroops)} XLM (the least the plan quoted).`;
    case "transfer":
      return row.destination === null ? (
        "No destination recorded for this transfer."
      ) : (
        <>
          Sent to{" "}
          <FullAddress
            value={row.destination}
            label={`${row.code} transfer destination`}
            className="text-white/80"
          />
        </>
      );
    case "issuer":
      return `Returned to its issuer. You are giving up ${holding(row)} permanently.`;
    case "leave":
      return `Left with this address. You are giving up ${holding(row)}: it stays out of reach unless this address is funded again.`;
    case "claim":
      return row.claimedStroops === null
        ? "Claimed into the account during the close."
        : `Claimed: adds ${formatStroops(row.claimedStroops)} XLM to what you receive.`;
    case "forfeit":
      return `Left unclaimed. You are giving up ${holding(row)}: it stays out of reach unless this address is funded again.`;
    case "undecided":
      return "No choice recorded for this item.";
  }
}

/** What happens to each asset, from the user's own answers, and the sum it leads to. */
export default function AssetOutcomeTable({ rows, expected }: AssetOutcomeTableProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>What happens to each asset</CardTitle>
      </CardHeader>
      {rows.length > 0 && (
        <ul aria-label="What happens to each asset" className="divide-y divide-white/8 px-4">
          {rows.map((row) => (
            <li key={row.key} className="py-3" data-testid="asset-outcome">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-sm font-medium text-white/90">
                  {row.kind === "claim" ? `Claimable ${holding(row)}` : holding(row)}
                </span>
                {row.symbolFromContract && (
                  <span className="text-xs text-fg-subtle">symbol set by the token contract</span>
                )}
                {row.givenUp && <Badge tone="danger">Given up</Badge>}
                {row.amount === null && row.kind !== "claim" && (
                  <span className="text-xs text-fg-subtle">arrives during the close</span>
                )}
              </div>
              {row.issuer && (
                <p className="text-xs text-fg-subtle">
                  Issued by{" "}
                  <FullAddress
                    value={row.issuer}
                    label={`${row.code} issuer address`}
                    className="text-white/70"
                  />
                </p>
              )}
              {row.contract && (
                <p className="text-xs text-fg-subtle">
                  Contract{" "}
                  <FullAddress
                    value={row.contract}
                    label={`${row.code} contract address`}
                    className="text-white/70"
                  />
                </p>
              )}
              <p
                className={
                  row.givenUp ? "mt-1 text-sm text-danger-fg" : "mt-1 text-sm text-fg-muted"
                }
                data-testid="asset-outcome-action"
              >
                {outcome(row)}
              </p>
            </li>
          ))}
        </ul>
      )}
      {expected === null ? (
        <p
          className="border-t border-white/10 px-4 py-3 text-sm text-fg-muted"
          data-testid="net-estimate"
        >
          The amount you will receive could not be estimated for this plan.
        </p>
      ) : (
        <div className="space-y-2 border-t border-white/10 px-4 py-3" data-testid="net-estimate">
          <ExpectedReceiveBreakdown expected={expected} showTotal />
          {receiveFigure(expected).feesExceed && (
            <Callout tone="warning" announce={false}>
              {FEES_EXCEED_BALANCE}
            </Callout>
          )}
          <p className="text-xs text-fg-subtle">
            How we calculate this: your XLM balance, less the network fees, plus the least each swap
            may deliver, plus the XLM this close claims. {estimateNote(expected)}
          </p>
        </div>
      )}
    </Card>
  );
}
