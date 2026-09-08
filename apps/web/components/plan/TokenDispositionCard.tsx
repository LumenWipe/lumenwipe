"use client";

import { AlertCircle, AlertTriangle, ArrowRightLeft, CheckCircle2, Send } from "lucide-react";
import { formatStroops, type AssetConvertibility } from "@/lib/api/plan-adapters";
import type { AssetDisposition } from "@/types/plan";
import { isValidGAddress } from "@/lib/utils/validation";
import { cn } from "@/lib/utils/cn";

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

  const showAddressError = !!transferDestination && !isValidGAddress(transferDestination);
  const errorId = `token-transfer-error-${token.contract}`;
  const helpId = `token-transfer-help-${token.contract}`;
  const unknownUnits = token.decimals === null;

  const headline = isTransfer
    ? "another account"
    : isLeave
      ? "stays with this address"
      : isConvert
        ? "XLM"
        : "needs a decision";

  return (
    <div
      className={cn(
        "rounded-lg border p-3 transition-colors",
        resolved
          ? isLeave
            ? "border-white/15 bg-white/[0.03]"
            : "border-emerald-500/20 bg-emerald-500/5"
          : "border-amber-500/30 bg-amber-500/[0.06]"
      )}
      data-testid={`token-card-${token.contract}`}
    >
      <div className="flex items-start gap-3">
        {isConvert ? (
          <ArrowRightLeft className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
        ) : isTransfer ? (
          <Send className="mt-0.5 h-4 w-4 shrink-0 text-white/50" />
        ) : isLeave ? (
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-white/50" />
        ) : (
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-white">
            {item.code} <span className="text-white/40">→</span> {headline}
          </p>
          <p className="text-xs text-white/50">
            {token.arrivesFromExit
              ? "Paid out when a position is exited"
              : `${item.balance} ${item.code}`}
            <span className="text-white/35"> · Soroban token {shortContract(token.contract)}</span>
          </p>
          {!item.convertible && !isTransfer && !isLeave && (
            <p className="mt-1 text-xs leading-relaxed text-white/55">
              {unknownUnits
                ? "This token does not report its symbol or decimals, so the balance is shown in raw units and cannot be exchanged for XLM. "
                : "There is no route to exchange this token for XLM. "}
              Closing the account does not remove the balance: it stays bound to this key, out of
              reach unless the address is funded again. Send it to an account you control, or
              confirm that it stays.
            </p>
          )}
        </div>
        <span
          className={cn(
            "shrink-0 rounded-full border px-2 py-0.5 text-[0.65rem] font-medium uppercase tracking-wide",
            isConvert
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
              : resolved
                ? "border-white/20 bg-white/5 text-white/70"
                : "border-amber-500/30 bg-amber-500/10 text-amber-300"
          )}
        >
          {isConvert ? "Swap" : isTransfer ? "Send" : isLeave ? "Stays" : "Decide"}
        </span>
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
                <span className="text-white/40">
                  About {formatStroops(token.quote.amountOut)} XLM, at least{" "}
                  {formatStroops(token.quote.minAmountOut)} XLM, through Soroswap
                  {token.quote.route.length > 0 ? ` (${token.quote.route.join(", ")})` : ""}.
                </span>
              ) : (
                <span className="text-white/40">Through the Soroswap aggregator.</span>
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
            <span className="text-white/40">You keep the tokens. No trustline is needed.</span>
          </span>
        </label>
        {isTransfer && (
          <div className="space-y-1.5 pl-5">
            <input
              type="text"
              value={transferDestination ?? ""}
              onChange={(e) => onSetTransferDestination(item.asset, e.target.value.trim() || null)}
              placeholder="G... (an account that exists)"
              spellCheck={false}
              autoComplete="off"
              aria-label={`Destination account for ${item.code}`}
              aria-invalid={showAddressError}
              aria-describedby={showAddressError ? errorId : helpId}
              className={cn(
                "w-full rounded-md border bg-black/30 px-2.5 py-1.5 font-mono text-xs text-white",
                "placeholder:font-sans placeholder:text-white/30",
                "focus:outline-none focus:ring-1",
                showAddressError
                  ? "border-destructive/50 focus:border-destructive focus:ring-destructive/40"
                  : "border-white/10 focus:border-stellar/50 focus:ring-stellar/40"
              )}
            />
            {showAddressError && (
              <p
                id={errorId}
                role="alert"
                className="flex items-center gap-1 text-[0.7rem] text-destructive"
              >
                <AlertCircle className="h-3 w-3 shrink-0" />
                Not a valid Stellar address (must start with G)
              </p>
            )}
            {mergeDestination && transferDestination !== mergeDestination && (
              <button
                type="button"
                onClick={() => onSetTransferDestination(item.asset, mergeDestination)}
                className="text-[0.7rem] text-stellar/90 underline-offset-2 hover:underline"
              >
                Use the same account I&apos;m merging into
              </button>
            )}
            <p id={helpId} className="text-[0.7rem] leading-relaxed text-white/45">
              Not an exchange deposit address: a token transfer carries no deposit memo, so an
              exchange could not credit it.
            </p>
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
            <span className="text-amber-300/80">
              The account closes anyway; these tokens stay out of reach unless this address is
              funded again.
            </span>
          </span>
        </label>
      </div>
    </div>
  );
}
