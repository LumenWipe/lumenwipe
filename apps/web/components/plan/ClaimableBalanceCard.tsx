"use client";

import { AlertTriangle, CheckCircle2, Target } from "lucide-react";
import type { ClaimableBalanceDecision } from "@/lib/api/plan-adapters";
import type { ClaimableBalanceSelection } from "@/types/plan";
import { describeClaimPredicate } from "@/lib/stellar/claim-predicates";
import { cn } from "@/lib/utils/cn";
import { DECISION_TAGS, DecisionCard, type DecisionOption } from "@/components/ui/decision-card";

interface ClaimableBalanceCardProps {
  item: ClaimableBalanceDecision;
  /** The user's current selection for this balance, or undefined if not yet chosen. */
  selection: ClaimableBalanceSelection | undefined;
  onSelect: (balanceId: string, selection: ClaimableBalanceSelection) => void;
}

/**
 * One claimable balance's disposition. A balance the account can already claim is shown
 * positively (like the "Swap" label) and defaults to being claimed, with forfeiting it as the
 * other option. A balance with no authorized trustline stays unresolved (amber) until the user
 * picks between adding a trustline to claim it or forfeiting it.
 */
export default function ClaimableBalanceCard({
  item,
  selection,
  onSelect,
}: ClaimableBalanceCardProps) {
  const predicateNote = describeClaimPredicate(item.predicate);
  const legend = `What happens to the ${item.amount} ${item.code} claimable balance`;
  const choose = (next: ClaimableBalanceSelection): void => onSelect(item.balanceId, next);
  const forfeitOption: DecisionOption<ClaimableBalanceSelection> = {
    value: "forfeit",
    label: "Forfeit it.",
    tag: DECISION_TAGS.giveUp,
    detail: "Inaccessible after the account is merged.",
  };

  if (item.currentlyClaimable) {
    const forfeited = selection === "forfeit";
    return (
      <DecisionCard
        legend={legend}
        options={[
          {
            value: "claim",
            label: "Claim it.",
            tag: DECISION_TAGS.recommended,
            detail: `Adds the ${item.amount} ${item.code} to your account.`,
          },
          forfeitOption,
        ]}
        value={selection}
        onValueChange={choose}
        tone={forfeited ? "neutral" : "success"}
      >
        <div className="flex items-center gap-3">
          <Target
            className={cn("h-4 w-4 shrink-0", forfeited ? "text-fg-subtle" : "text-success")}
          />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-white">
              {item.amount} {item.code}
            </p>
            <p className="text-xs text-fg-muted">
              {forfeited
                ? "This claimable balance will be left unclaimed."
                : "This claimable balance will be claimed and added to your account."}
            </p>
          </div>
        </div>
      </DecisionCard>
    );
  }

  const resolved = selection === "add_trustline_then_claim" || selection === "forfeit";

  return (
    <DecisionCard
      legend={legend}
      options={[
        {
          value: "add_trustline_then_claim",
          label: `Add a ${item.code} trustline and claim it.`,
          tag: DECISION_TAGS.keep,
          detail: `Recovers the ${item.amount} ${item.code}.`,
        },
        forfeitOption,
      ]}
      value={selection}
      onValueChange={choose}
      tone={resolved ? "neutral" : "warning"}
    >
      <div className="flex items-start gap-3">
        {resolved ? (
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-fg-muted" />
        ) : (
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-white">
            {item.amount} {item.code} <span className="text-fg-subtle">·</span>{" "}
            <span className="text-warning">no trustline for this asset</span>
          </p>
          <p className="mt-1 text-xs leading-relaxed text-fg-muted">
            This account is a claimant for this balance but holds no {item.code} trustline. Add one
            to claim it, or leave it behind - it becomes permanently inaccessible once the account
            is merged.
          </p>
          {predicateNote && <p className="mt-1 text-xs text-fg-subtle">{predicateNote}</p>}
        </div>
      </div>
    </DecisionCard>
  );
}
