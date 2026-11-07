"use client";

import { AlertTriangle, CheckCircle2, Target } from "lucide-react";
import type { ClaimableBalanceDecision } from "@/lib/api/plan-adapters";
import type { ClaimableBalanceSelection } from "@/types/plan";
import { describeClaimPredicate } from "@/lib/stellar/claim-predicates";
import { cn } from "@/lib/utils/cn";
import { Card } from "@/components/ui/card";
import { shortenAddress } from "@/components/ui/short-address";
import { DECISION_TAGS, DecisionCard, type DecisionOption } from "@/components/ui/decision-card";

interface ClaimableBalanceCardProps {
  item: ClaimableBalanceDecision;
  /** The user's current selection for this balance, or undefined if not yet chosen. */
  selection: ClaimableBalanceSelection | undefined;
  onSelect: (balanceId: string, selection: ClaimableBalanceSelection) => void;
}

/**
 * One claimable balance's disposition, offering only the answers the plan offers for it. A
 * balance the account can already claim is shown positively (like the "Swap" label) and defaults
 * to being claimed, with leaving it unclaimed as the other option. A balance with no authorized
 * trustline stays unresolved (amber) until the user picks between adding a trustline to claim it
 * or leaving it unclaimed. One the account cannot claim in this close at all (its claim window, or a
 * reserve too low for the trustline) offers leaving it only, and still needs that answer.
 */
export default function ClaimableBalanceCard({
  item,
  selection,
  onSelect,
}: ClaimableBalanceCardProps) {
  const predicateNote = describeClaimPredicate(item.predicate);
  const issuer = item.asset === "native" ? null : (item.asset.split(":")[1] ?? null);
  const legend = `What happens to the ${item.amount} ${item.code} claimable balance${
    issuer ? ` issued by ${shortenAddress(issuer)}` : ""
  }`;
  const choose = (next: ClaimableBalanceSelection): void => onSelect(item.balanceId, next);
  const allOptions: DecisionOption<ClaimableBalanceSelection>[] = [
    {
      value: "claim",
      label: "Claim it.",
      tag: DECISION_TAGS.recommended,
      detail: `Adds the ${item.amount} ${item.code} to your account.`,
    },
    {
      value: "add_trustline_then_claim",
      label: `Add a ${item.code} trustline and claim it.`,
      tag: DECISION_TAGS.keepBalance,
      detail: `Recovers the ${item.amount} ${item.code}.`,
    },
    {
      value: "forfeit",
      label: "Leave it unclaimed.",
      tag: DECISION_TAGS.giveUpBalance,
      // Full contrast: giving value up is the consequence that must not be the dimmest text.
      detail: <span className="text-fg">Inaccessible to this account once it is merged.</span>,
      // Not a `notice`: that one is a live region, and a bulk leave over a group would announce
      // it once per card. The bulk result is announced once instead.
      children: (
        <p className="flex items-start gap-1.5 text-xs text-fg">
          <AlertTriangle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
          This balance will be unreachable once the account is merged.
        </p>
      ),
    },
  ];
  const options = allOptions.filter((o) => item.offered.includes(o.value));
  const resolved = selection !== undefined && item.offered.includes(selection);

  if (options.length === 0) {
    return (
      <Card tone="warning" className="p-3">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <p className="text-sm text-fg">
            {item.amount} {item.code}: the choices for this claimable balance could not be read.
            Refresh the plan to answer it.
          </p>
        </div>
      </Card>
    );
  }

  if (item.offered.includes("claim")) {
    const forfeited = selection === "forfeit";
    return (
      <DecisionCard
        legend={legend}
        options={options}
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

  const canAddTrustline = item.offered.includes("add_trustline_then_claim");

  return (
    <DecisionCard
      legend={legend}
      options={options}
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
            <span className="text-warning">
              {canAddTrustline ? "no trustline for this asset" : "cannot be claimed in this close"}
            </span>
          </p>
          <p className="mt-1 text-xs leading-relaxed text-fg-muted">
            {canAddTrustline
              ? `This account is a claimant for this balance but holds no ${item.code} trustline. Add one to claim it, or leave it behind - it becomes permanently inaccessible once the account is merged.`
              : (item.unclaimableNote ??
                "This account cannot claim this balance in this close. Leaving it behind is the only answer, and it becomes permanently inaccessible once the account is merged.")}
          </p>
          {predicateNote && <p className="mt-1 text-xs text-fg-subtle">{predicateNote}</p>}
        </div>
      </div>
    </DecisionCard>
  );
}
