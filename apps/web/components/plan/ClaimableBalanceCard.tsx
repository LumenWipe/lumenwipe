"use client";

import { AlertTriangle, CheckCircle2, Gift } from "lucide-react";
import type { ClaimableBalanceDecision } from "@/lib/api/plan-adapters";
import type { ClaimableBalanceSelection } from "@/types/plan";
import { describeClaimPredicate } from "@/lib/stellar/claim-predicates";
import { cn } from "@/lib/utils/cn";

interface ClaimableBalanceCardProps {
  item: ClaimableBalanceDecision;
  /** The user's current selection for this balance, or undefined if not yet chosen. */
  selection: ClaimableBalanceSelection | undefined;
  onSelect: (balanceId: string, selection: ClaimableBalanceSelection) => void;
}

/**
 * One claimable balance's disposition. A balance the account can already claim is shown
 * positively (like the "Swap" label) with an opt-out checkbox - unchecking it forfeits the
 * balance. A balance with no authorized trustline stays unresolved (amber) until the user
 * picks between adding a trustline to claim it or forfeiting it.
 */
export default function ClaimableBalanceCard({ item, selection, onSelect }: ClaimableBalanceCardProps) {
  const predicateNote = describeClaimPredicate(item.predicate);

  if (item.currentlyClaimable) {
    const forfeited = selection === "forfeit";
    return (
      <div
        className={cn(
          "flex items-center gap-3 rounded-lg border p-3",
          forfeited ? "border-white/15 bg-white/[0.03]" : "border-emerald-500/20 bg-emerald-500/5"
        )}
      >
        <Gift className={cn("h-4 w-4 shrink-0", forfeited ? "text-white/40" : "text-emerald-400")} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-white">
            {item.amount} {item.code}
          </p>
          <p className="text-xs text-white/50">
            {forfeited
              ? "This claimable balance will be left unclaimed."
              : "This claimable balance will be claimed and added to your account."}
          </p>
        </div>
        <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-white/60">
          <input
            type="checkbox"
            checked={!forfeited}
            onChange={(e) => onSelect(item.balanceId, e.target.checked ? "claim" : "forfeit")}
            className="h-3.5 w-3.5 accent-stellar"
          />
          Claim
        </label>
      </div>
    );
  }

  const resolved = selection === "add_trustline_then_claim" || selection === "forfeit";

  return (
    <div
      className={cn(
        "rounded-lg border p-3 transition-colors",
        resolved ? "border-white/15 bg-white/[0.03]" : "border-amber-500/30 bg-amber-500/[0.06]"
      )}
    >
      <div className="flex items-start gap-3">
        {resolved ? (
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-white/50" />
        ) : (
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-white">
            {item.amount} {item.code} <span className="text-white/40">·</span>{" "}
            <span className="text-amber-300/90">no trustline for this asset</span>
          </p>
          <p className="mt-1 text-xs leading-relaxed text-white/55">
            This account is a claimant for this balance but holds no {item.code} trustline. Add one
            to claim it, or leave it behind - it becomes permanently inaccessible once the account
            is merged.
          </p>
          {predicateNote && <p className="mt-1 text-xs text-white/45">{predicateNote}</p>}
        </div>
      </div>

      <div className="mt-3 space-y-1.5 pl-7">
        <label className="flex cursor-pointer items-start gap-2 text-xs text-white/70">
          <input
            type="radio"
            name={`claim-${item.balanceId}`}
            checked={selection === "add_trustline_then_claim"}
            onChange={() => onSelect(item.balanceId, "add_trustline_then_claim")}
            className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-stellar"
          />
          <span>
            Add a {item.code} trustline and claim it.{" "}
            <span className="text-white/40">Recovers the {item.amount} {item.code}.</span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-2 text-xs text-white/70">
          <input
            type="radio"
            name={`claim-${item.balanceId}`}
            checked={selection === "forfeit"}
            onChange={() => onSelect(item.balanceId, "forfeit")}
            className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-stellar"
          />
          <span>
            Forfeit it. <span className="text-white/40">Inaccessible after the account is merged.</span>
          </span>
        </label>
      </div>
    </div>
  );
}
