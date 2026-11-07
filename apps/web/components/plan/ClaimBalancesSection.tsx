"use client";

import { useState } from "react";
import type { ClaimableBalanceDecision } from "@/lib/api/plan-adapters";
import type { ClaimableBalanceSelection } from "@/types/plan";
import { claimGroups } from "@/lib/plan/open-items";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ShortAddress, shortenAddress } from "@/components/ui/short-address";
import ClaimableBalanceCard from "./ClaimableBalanceCard";

type BulkChoice = Extract<ClaimableBalanceSelection, "claim" | "forfeit">;

interface ClaimBalancesSectionProps {
  decisions: ClaimableBalanceDecision[];
  selections: Record<string, ClaimableBalanceSelection>;
  onSelect: (balanceId: string, selection: ClaimableBalanceSelection) => void;
  /** Sets each listed balance, one answer per id, and announces `result` once. */
  onBulkSelect: (balanceIds: string[], selection: BulkChoice, result: string) => void;
  /** Undoes a bulk action for the balances still holding its answer, and announces the outcome. */
  onUndo: (previous: Record<string, ClaimableBalanceSelection>, bulkChoice: BulkChoice) => void;
}

interface BulkResult {
  asset: string;
  text: string;
  choice: BulkChoice;
  previous: Record<string, ClaimableBalanceSelection>;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The claimable balances grouped by asset, with a count, a total and a running answered count. A
 * bulk answer sets only the balances its group lists that can be claimed now, each by its own id:
 * there is no group-level answer, so a balance that appears later starts unanswered. A group
 * collapses once every balance in it is answered; its bulk actions stay in reach.
 */
export default function ClaimBalancesSection({
  decisions,
  selections,
  onSelect,
  onBulkSelect,
  onUndo,
}: ClaimBalancesSectionProps) {
  const [result, setResult] = useState<BulkResult | null>(null);
  const groups = claimGroups(decisions, selections);
  const answered = groups.reduce((n, g) => n + g.answered, 0);

  function bulk(asset: string, code: string, ids: string[], choice: BulkChoice) {
    const previous: Record<string, ClaimableBalanceSelection> = {};
    for (const id of ids) {
      // Unanswered here means claimed by default: a bulk group holds only claimable-now balances.
      previous[id] = selections[id] ?? "claim";
    }
    const text = `Set ${plural(ids.length, `${code} balance`, `${code} balances`)} to ${
      choice === "claim" ? "be claimed" : "be left unclaimed"
    }.`;
    setResult({ asset, text, choice, previous });
    onBulkSelect(ids, choice, text);
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-fg-muted">
        {answered} of {decisions.length} answered
      </p>
      {groups.map((g) => {
        const done = g.answered === g.balances.length;
        const issuedBy = g.issuer ? ` issued by ${shortenAddress(g.issuer)}` : "";
        const own = g.balances.length - g.bulkIds.length;
        return (
          <section
            key={g.asset}
            aria-label={`${g.code} claimable balances${issuedBy}`}
            className="space-y-2 rounded-md border border-edge/10 p-2.5"
          >
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium text-fg">
                {g.code}{" "}
                <span className="font-normal text-fg-muted">
                  · {plural(g.balances.length, "balance", "balances")}
                  {g.total !== null && ` · ${g.total} ${g.code} in total`}
                </span>
              </p>
              {g.issuer && (
                <span className="text-xs text-fg-subtle">
                  Issued by <ShortAddress value={g.issuer} label={`${g.code} issuer address`} />
                </span>
              )}
              <Badge tone={done ? "success" : "warning"} className="ml-auto">
                {g.answered} of {g.balances.length} answered
              </Badge>
            </div>
            {(g.bulkIds.length > 0 || own > 0) && (
              <div className="flex flex-wrap items-center gap-2">
                {g.bulkIds.length > 0 && (
                  <>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => bulk(g.asset, g.code, g.bulkIds, "claim")}
                    >
                      Claim all
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => bulk(g.asset, g.code, g.bulkIds, "forfeit")}
                    >
                      Leave all unclaimed
                    </Button>
                  </>
                )}
                {own > 0 && (
                  <span className="text-xs text-fg-muted">
                    {own === 1
                      ? "1 balance needs its own answer below."
                      : `${own} balances need their own answer below.`}
                  </span>
                )}
              </div>
            )}
            {result?.asset === g.asset && (
              <p className="flex flex-wrap items-center gap-2 text-xs text-fg">
                {result.text}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    onUndo(result.previous, result.choice);
                    setResult(null);
                  }}
                >
                  Undo
                </Button>
              </p>
            )}
            <details open={!done}>
              <summary className="cursor-pointer text-xs text-fg-muted">
                The {plural(g.balances.length, "balance", "balances")}
              </summary>
              <div className="mt-2 space-y-2">
                {g.balances.map((b) => (
                  <div key={b.balanceId} data-open-item={`claim:${b.balanceId}`}>
                    <ClaimableBalanceCard
                      item={b}
                      selection={selections[b.balanceId]}
                      onSelect={onSelect}
                    />
                  </div>
                ))}
              </div>
            </details>
          </section>
        );
      })}
    </div>
  );
}
