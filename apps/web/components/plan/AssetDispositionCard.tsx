"use client";

import { ArrowRightLeft, AlertTriangle, CheckCircle2, Send } from "lucide-react";
import { formatStroops, type AssetConvertibility } from "@/lib/api/plan-adapters";
import { classicFloorFromQuote } from "@/lib/api/close-decisions";
import type { AssetDisposition } from "@/types/plan";
import { AddressField } from "@/components/ui/address-field";
import {
  isUsableTransferDestination,
  transferDestinationError,
} from "@/lib/plan/transfer-destination";
import { Badge } from "@/components/ui/badge";
import { ShortAddress } from "@/components/ui/short-address";
import { DECISION_TAGS, DecisionCard, type DecisionOption } from "@/components/ui/decision-card";

interface AssetDispositionCardProps {
  item: AssetConvertibility;
  /** The disposition currently recorded for this asset, or undefined while unresolved. */
  disposition: AssetDisposition | undefined;
  /** The transfer destination recorded for this asset, if any. */
  transferDestination: string | undefined;
  /** The account the XLM is being merged into, offered as a one-click shortcut. Null until
   *  the user has entered one. */
  mergeDestination: string | null;
  onSetDisposition: (asset: string, disposition: AssetDisposition) => void;
  onSetTransferDestination: (asset: string, destination: string | null) => void;
}

/**
 * One balance-bearing asset's disposition.
 *
 * A convertible asset defaults to the swap and says so; a non-convertible one stays
 * unresolved (amber) until the user resolves it, which blocks proceeding in the meantime.
 * Either can instead be sent, as the asset, to another account.
 *
 * The transfer option is offered for both. For an asset with no swap route it is the only
 * choice that does not destroy the balance, which is precisely when a user is most likely to
 * want it.
 *
 * The convertible branch also honours a stored "issuer". Dispositions outlive a re-analyze, so
 * an asset answered "return to issuer" while it had no route can become convertible when one
 * appears - and rendering only transfer-or-swap there would have shown a green "Swap" badge and
 * "will be swapped to XLM" over a plan that burns the balance.
 */
export default function AssetDispositionCard({
  item,
  disposition,
  transferDestination,
  mergeDestination,
  onSetDisposition,
  onSetTransferDestination,
}: AssetDispositionCardProps) {
  const isTransfer = disposition === "transfer";
  const isIssuer = disposition === "issuer";
  // A transfer is only resolved once its destination is a usable address. Until then the asset
  // counts as unresolved, exactly like an unconfirmed return-to-issuer.
  const transferReady = isTransfer && isUsableTransferDestination(transferDestination);
  const resolved = item.convertible ? !isTransfer || transferReady : isIssuer || transferReady;

  // Before the exit that pays it in, the balance is genuinely zero, and "0 AQUA will be swapped"
  // reads as a no-op rather than as the decision it is.
  const amountPhrase = (outcome: string): string =>
    item.arrivesFromExit
      ? `What this account's exit pays out in ${item.code} will be ${outcome}.`
      : `${item.balance} ${item.code} will be ${outcome}.`;
  /** "my 410.25 AQUA" once it is there, "my AQUA" while it is still inside the position. */
  const holding = item.arrivesFromExit ? `my ${item.code}` : `my ${item.balance} ${item.code}`;

  // Two trustlines can share a code, so the issuer is what tells a real asset from a look-alike.
  const issuerLine = item.issuer ? (
    <p className="text-xs text-fg-subtle">
      Issued by <ShortAddress value={item.issuer} label={`${item.code} issuer address`} />
    </p>
  ) : null;

  const clawbackNote = item.clawbackEnabled ? (
    <p className="mt-2 pl-7 text-xs leading-relaxed text-fg-muted">
      The issuer of {item.code} can reclaim this balance at any time, including before the close
      completes.
    </p>
  ) : null;

  const transferOption: DecisionOption<AssetDisposition> = {
    value: "transfer",
    label: `Send ${holding} to another account instead.`,
    tag: DECISION_TAGS.keep,
    notice: (
      <>
        The receiving account must already hold a {item.code} trustline. LumenWipe cannot add one
        for it, and the whole close fails if it cannot receive the balance.
      </>
    ),
    children: (
      <div className="space-y-1.5">
        <AddressField
          label={`Destination account for ${item.code}`}
          hideLabel
          value={transferDestination ?? ""}
          onChange={(next) => onSetTransferDestination(item.asset, next || null)}
          error={transferDestination ? transferDestinationError(transferDestination) : null}
          placeholder={`G... (an account that already holds ${item.code})`}
        />
        {/* A shortcut, not a constraint: the API takes any address per asset, and hiding that
            behind a single fixed destination would make the UI narrower than the contract. */}
        {isUsableTransferDestination(mergeDestination) &&
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
  };
  const issuerOption: DecisionOption<AssetDisposition> = {
    value: "issuer",
    label: `Return ${holding} to the issuer.`,
    tag: DECISION_TAGS.giveUp,
  };
  const legend = `What happens to ${item.code}`;
  const choose = (next: AssetDisposition): void => onSetDisposition(item.asset, next);

  if (item.convertible) {
    const swapOption: DecisionOption<AssetDisposition> = {
      value: "convert",
      label: `Swap ${holding} to XLM on the DEX.`,
      tag: DECISION_TAGS.recommended,
    };
    return (
      <DecisionCard
        legend={legend}
        options={
          isIssuer ? [swapOption, transferOption, issuerOption] : [swapOption, transferOption]
        }
        value={disposition}
        onValueChange={choose}
        tone={resolved ? "success" : "warning"}
      >
        <div className="flex items-center gap-3">
          {isTransfer || isIssuer ? (
            <Send className="h-4 w-4 shrink-0 text-fg-muted" />
          ) : (
            <ArrowRightLeft className="h-4 w-4 shrink-0 text-success" />
          )}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-white">
              {item.code} <span className="text-fg-subtle">→</span>{" "}
              {isTransfer ? "another account" : isIssuer ? "its issuer" : "XLM"}
            </p>
            <p className="text-xs text-fg-muted">
              {isTransfer
                ? amountPhrase(`sent as ${item.code}, not swapped`)
                : isIssuer
                  ? amountPhrase("returned to its issuer") + " You give up these tokens."
                  : amountPhrase("swapped to XLM on the DEX") +
                    (item.quote
                      ? ` About ${formatStroops(item.quote.estimatedReceive)} XLM, at least ${formatStroops(classicFloorFromQuote(item.quote.minAmountOut))} XLM.`
                      : " Estimate unavailable.")}
            </p>
            {issuerLine}
          </div>
          <Badge
            tone={isTransfer || isIssuer ? "neutral" : "success"}
            className="shrink-0 uppercase tracking-wide"
          >
            {isTransfer ? "Send" : isIssuer ? "Return" : "Swap"}
          </Badge>
        </div>
        {clawbackNote}
      </DecisionCard>
    );
  }

  return (
    <DecisionCard
      legend={legend}
      options={[issuerOption, transferOption]}
      value={disposition}
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
            {item.code} <span className="text-fg-subtle">·</span>{" "}
            <span className="text-warning">
              {item.dust ? "too small to swap" : "no swap route on the DEX"}
            </span>
          </p>
          {issuerLine}
          <p className="mt-1 text-xs leading-relaxed text-fg-muted">
            {item.dust
              ? `${holding.replace(/^my /, "")} is below the smallest amount the market will swap to XLM.`
              : `There is no way to swap ${holding} to XLM.`}{" "}
            A trustline with a balance cannot be removed, so the account cannot be closed while this
            balance remains. You can send these tokens to another account that holds them, or return
            them to the issuer and give them up.
          </p>
        </div>
      </div>
      {clawbackNote}
    </DecisionCard>
  );
}
