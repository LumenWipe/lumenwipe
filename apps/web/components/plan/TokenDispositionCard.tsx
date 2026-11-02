"use client";

import { AlertTriangle, ArrowRightLeft, CheckCircle2, Send } from "lucide-react";
import { formatStroops, type AssetConvertibility } from "@/lib/api/plan-adapters";
import type { AssetDisposition } from "@/types/plan";
import { AddressField } from "@/components/ui/address-field";
import { addressErrorMessage, isValidGAddress } from "@/lib/utils/validation";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";

interface TokenDispositionCardProps {
  item: AssetConvertibility;
  disposition: AssetDisposition | undefined;
  transferDestination: string | undefined;
  mergeDestination: string | null;
  onSetDisposition: (asset: string, disposition: AssetDisposition) => void;
  onSetTransferDestination: (asset: string, destination: string | null) => void;
}

function shortContract(contract: string): string {
  return `${contract.slice(0, 4)}…${contract.slice(-4)}`;
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
  item,
  disposition,
  transferDestination,
  mergeDestination,
  onSetDisposition,
  onSetTransferDestination,
}: TokenDispositionCardProps) {
  const token = item.token!;
  const isTransfer = disposition === "transfer";
  const isLeave = disposition === "leave";
  const isConvert = disposition === "convert" && item.convertible;
  const transferReady = isTransfer && !!transferDestination && isValidGAddress(transferDestination);
  const resolved = isConvert || isLeave || transferReady;

  const unknownUnits = token.decimals === null;

  const headline = isTransfer
    ? "another account"
    : isLeave
      ? "stays with this address"
      : isConvert
        ? "XLM"
        : "needs a decision";

  return (
    <Card
      tone={resolved ? (isLeave ? "neutral" : "success") : "warning"}
      className="p-3 transition-colors"
      data-testid={`token-card-${token.contract}`}
    >
      <div className="flex items-start gap-3">
        {isConvert ? (
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
            <span className="text-fg-subtle"> · Soroban token {shortContract(token.contract)}</span>
          </p>
          {!item.convertible && !isTransfer && !isLeave && (
            <p className="mt-1 text-xs leading-relaxed text-fg-muted">
              {unknownUnits
                ? "This token does not report its symbol or decimals, so the balance is shown in raw units and cannot be exchanged for XLM. "
                : "There is no route to exchange this token for XLM. "}
              Closing the account does not remove the balance: it stays bound to this key, out of
              reach unless the address is funded again. Send it to an account you control, or
              confirm that it stays.
            </p>
          )}
        </div>
        <Badge
          tone={isConvert ? "success" : resolved ? "neutral" : "warning"}
          className="shrink-0 uppercase tracking-wide"
        >
          {isConvert ? "Swap" : isTransfer ? "Send" : isLeave ? "Stays" : "Decide"}
        </Badge>
      </div>

      <div className="mt-3 space-y-2 pl-7">
        {item.convertible && (
          <label className="flex cursor-pointer items-start gap-2 text-xs text-white/70">
            <input
              type="radio"
              name={`token-${token.contract}`}
              checked={isConvert}
              onChange={() => onSetDisposition(item.asset, "convert")}
              className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-stellar"
            />
            <span>
              Exchange my {item.balance} {item.code} for XLM.{" "}
              {token.quote ? (
                <span className="text-fg-subtle">
                  About {formatStroops(token.quote.amountOut)} XLM, at least{" "}
                  {formatStroops(token.quote.minAmountOut)} XLM, through{" "}
                  {token.quote.provider === "xbull" ? "xBull" : "Soroswap"}
                  {token.quote.route.length > 0 ? ` (${token.quote.route.join(", ")})` : ""}.
                </span>
              ) : (
                <span className="text-fg-subtle">Through the best available route.</span>
              )}
            </span>
          </label>
        )}
        <label className="flex cursor-pointer items-start gap-2 text-xs text-white/70">
          <input
            type="radio"
            name={`token-${token.contract}`}
            checked={isTransfer}
            onChange={() => onSetDisposition(item.asset, "transfer")}
            className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-stellar"
          />
          <span>
            Send my {item.balance} {item.code} to another account.{" "}
            <span className="text-fg-subtle">You keep the tokens. No trustline is needed.</span>
          </span>
        </label>
        {isTransfer && (
          <div className="space-y-1.5 pl-5">
            <AddressField
              label={`Destination account for ${item.code}`}
              hideLabel
              value={transferDestination ?? ""}
              onChange={(next) => onSetTransferDestination(item.asset, next || null)}
              error={transferDestination ? addressErrorMessage(transferDestination) : null}
              placeholder="G... (an account that exists)"
              helper="Not an exchange deposit address: a token transfer carries no deposit memo, so an exchange could not credit it."
            />
            {mergeDestination && transferDestination !== mergeDestination && (
              <button
                type="button"
                onClick={() => onSetTransferDestination(item.asset, mergeDestination)}
                className="text-[0.7rem] text-stellar/90 underline-offset-2 hover:underline"
              >
                Use the same account I&apos;m merging into
              </button>
            )}
          </div>
        )}
        <label className="flex cursor-pointer items-start gap-2 text-xs text-white/70">
          <input
            type="radio"
            name={`token-${token.contract}`}
            checked={isLeave}
            onChange={() => onSetDisposition(item.asset, "leave")}
            className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-stellar"
          />
          <span>
            Leave my {item.balance} {item.code} with this address.{" "}
            <span className="text-warning">
              The account closes anyway; these tokens stay out of reach unless this address is
              funded again.
            </span>
          </span>
        </label>
      </div>
    </Card>
  );
}
