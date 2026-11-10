"use client";

import { AlertTriangle, ArrowRightLeft, CheckCircle2, Send } from "lucide-react";
import { formatStroops, type AssetConvertibility, type TokenQuote } from "@/lib/api/plan-adapters";
import type { Network } from "@/config/networks";
import type { AssetDisposition } from "@/types/plan";
import { AddressField } from "@/components/ui/address-field";
import {
  isUsableTransferDestination,
  transferDestinationError,
} from "@/lib/plan/transfer-destination";
import { Badge } from "@/components/ui/badge";
import { ShortAddress } from "@/components/ui/short-address";
import { DECISION_TAGS, DecisionCard, type DecisionOption } from "@/components/ui/decision-card";

interface TokenDispositionCardProps {
  network: Network;
  item: AssetConvertibility;
  disposition: AssetDisposition | undefined;
  transferDestination: string | undefined;
  mergeDestination: string | null;
  onSetDisposition: (asset: string, disposition: AssetDisposition) => void;
  onSetTransferDestination: (asset: string, destination: string | null) => void;
  /** Whether the user confirmed converting at the floor the convert answer carries now. */
  impactConfirmed: boolean;
  onConfirmImpact: (asset: string, confirmed: boolean) => void;
}

const PROVIDER_NAMES = { soroswap: "Soroswap", xbull: "xBull" } as const;

/** Basis points as a percentage, with no trailing zeros. */
function formatImpact(bps: number): string {
  return (bps / 100).toFixed(2).replace(/\.?0+$/, "");
}

/** Why a flagged quote is not recommended, in one sentence the user can weigh. */
function flaggedNotice(quote: TokenQuote): string {
  const parts: string[] = [];
  if (quote.flags.includes("high_impact") && quote.priceImpactBps !== null) {
    parts.push(
      `This swap delivers much less than the current market price suggests: a price impact of about ${formatImpact(quote.priceImpactBps)}%.`
    );
  }
  if (quote.flags.includes("impact_unknown")) {
    parts.push(
      "The price impact of this swap could not be measured, so it may deliver much less than the current market price suggests."
    );
  }
  if (quote.flags.includes("provider_disagreement") && quote.runnerUp) {
    parts.push(
      `The two swap providers disagree by more than 10%: ${PROVIDER_NAMES[quote.provider]} quotes about ${formatStroops(quote.amountOut)} XLM, ${PROVIDER_NAMES[quote.runnerUp.provider]} about ${formatStroops(quote.runnerUp.amountOut)} XLM, so the better quote may not hold.`
    );
  }
  return parts.join(" ");
}

/** Why there is no conversion to offer, as the plan reported it. */
function unconvertibleReason(item: AssetConvertibility): string {
  const token = item.token!;
  if (token.decimals === null || token.reason === "metadata_unreadable") {
    return "This token does not report its symbol or decimals, so the balance is shown in raw units and cannot be exchanged for XLM. ";
  }
  switch (token.reason) {
    case "quote_limit":
      return "This account holds more Soroban tokens than one plan prices, so this one was not quoted for an exchange. ";
    case "provider_unavailable":
      return "The swap providers did not answer in time, so this token could not be priced right now. Analyze again in a moment to see whether it can be exchanged. ";
    default:
      return "There is no route to exchange this token for XLM. ";
  }
}

/**
 * One Soroban token balance's disposition.
 *
 * Unlike a trustline, a token balance does not stop the close: the account can be merged with
 * the tokens still bound to its key, and that is precisely the danger - they would be left behind
 * in silence. So there is no unresolved-by-default here that quietly passes: the user converts the
 * balance (when a route exists), sends it as the token to an account they name, or acknowledges,
 * by name, that it stays with the address. Leaving is never pre-selected.
 */
export default function TokenDispositionCard({
  network,
  item,
  disposition,
  transferDestination,
  mergeDestination,
  onSetDisposition,
  onSetTransferDestination,
  impactConfirmed,
  onConfirmImpact,
}: TokenDispositionCardProps) {
  const token = item.token!;
  const isTransfer = disposition === "transfer";
  const isLeave = disposition === "leave";
  const isConvert = disposition === "convert" && item.convertible;
  const flagged = item.convertible && (token.quote?.flags.length ?? 0) > 0;
  const transferReady = isTransfer && isUsableTransferDestination(transferDestination, network);
  const convertReady = isConvert && (!flagged || impactConfirmed);
  const resolved = convertReady || isLeave || transferReady;

  const headline = isTransfer
    ? "another account"
    : isLeave
      ? "stays with this address"
      : convertReady
        ? "XLM"
        : "needs a decision";

  const options: DecisionOption<AssetDisposition>[] = [
    ...(item.convertible
      ? [
          {
            value: "convert" as const,
            label: `Exchange my ${item.balance} ${item.code} for XLM.`,
            tag: flagged ? DECISION_TAGS.confirmFirst : DECISION_TAGS.recommended,
            detail: token.quote ? (
              <>
                About {formatStroops(token.quote.amountOut)} XLM, at least{" "}
                {formatStroops(token.quote.minAmountOut)} XLM, through{" "}
                {PROVIDER_NAMES[token.quote.provider]}
                {token.quote.route.length > 0 ? ` (${token.quote.route.join(", ")})` : ""}
                {token.quote.priceImpactBps !== null
                  ? `, at a price impact of about ${formatImpact(token.quote.priceImpactBps)}%`
                  : ""}
                .
              </>
            ) : (
              "Through the best available route."
            ),
            ...(flagged && token.quote
              ? {
                  notice: flaggedNotice(token.quote),
                  children: (
                    <label className="flex cursor-pointer items-start gap-2 text-xs text-white/80">
                      <input
                        type="checkbox"
                        checked={impactConfirmed}
                        onChange={(e) => onConfirmImpact(item.asset, e.target.checked)}
                        className="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer accent-accent"
                      />
                      I still want to exchange my {item.balance} {item.code} for at least{" "}
                      {formatStroops(token.quote.minAmountOut)} XLM.
                    </label>
                  ),
                }
              : {}),
          },
        ]
      : []),
    {
      value: "transfer",
      label: `Send my ${item.balance} ${item.code} to another account.`,
      tag: DECISION_TAGS.keep,
      detail: "No trustline is needed.",
      children: (
        <div className="space-y-1.5">
          <AddressField
            label={`Destination account for ${item.code}`}
            hideLabel
            value={transferDestination ?? ""}
            onChange={(next) => onSetTransferDestination(item.asset, next || null)}
            error={
              transferDestination ? transferDestinationError(transferDestination, network) : null
            }
            placeholder="G... (an account that exists)"
            helper="Not an exchange deposit address: a token transfer carries no deposit memo, so an exchange could not credit it."
          />
          {isUsableTransferDestination(mergeDestination, network) &&
            transferDestination !== mergeDestination && (
              <button
                type="button"
                onClick={() => onSetTransferDestination(item.asset, mergeDestination)}
                className="text-label text-accent/90 underline-offset-2 hover:underline"
              >
                Use the same account I&apos;m merging into
              </button>
            )}
        </div>
      ),
    },
    {
      value: "leave",
      label: `Leave my ${item.balance} ${item.code} with this address.`,
      tag: DECISION_TAGS.giveUp,
      detail: (
        <span className="text-warning">
          The account closes anyway; these tokens stay out of reach unless this address is funded
          again.
        </span>
      ),
    },
  ];

  return (
    <DecisionCard
      legend={`What happens to ${item.code}`}
      options={options}
      value={disposition}
      onValueChange={(next) => onSetDisposition(item.asset, next)}
      tone={resolved ? (isLeave ? "neutral" : "success") : "warning"}
      data-testid={`token-card-${token.contract}`}
    >
      <div className="flex items-start gap-3">
        {convertReady ? (
          <ArrowRightLeft className="mt-0.5 h-4 w-4 shrink-0 text-success" />
        ) : isTransfer ? (
          <Send className="mt-0.5 h-4 w-4 shrink-0 text-fg-muted" />
        ) : isLeave ? (
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-fg-muted" />
        ) : (
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-white">
            {item.code} <span className="text-fg-subtle">→</span> {headline}
          </p>
          <p className="text-xs text-fg-muted">
            {token.arrivesFromExit
              ? "Paid out when a position is exited"
              : `${item.balance} ${item.code}`}
            <span className="text-fg-subtle">
              {" "}
              · Soroban token{" "}
              <ShortAddress value={token.contract} label={`${item.code} contract address`} />
            </span>
          </p>
          {!item.convertible && !isTransfer && !isLeave && (
            <p className="mt-1 text-xs leading-relaxed text-fg-muted">
              {unconvertibleReason(item)}
              Closing the account does not remove the balance: it stays bound to this key, out of
              reach unless the address is funded again. Send it to an account you control, or
              confirm that it stays.
            </p>
          )}
        </div>
        <Badge
          tone={convertReady ? "success" : resolved ? "neutral" : "warning"}
          className="shrink-0 uppercase tracking-wide"
        >
          {convertReady ? "Swap" : isTransfer ? "Send" : isLeave ? "Stays" : "Decide"}
        </Badge>
      </div>
    </DecisionCard>
  );
}
