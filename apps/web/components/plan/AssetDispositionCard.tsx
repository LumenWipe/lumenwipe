"use client";

import { ArrowRightLeft, AlertTriangle, CheckCircle2, Send } from "lucide-react";
import type { AssetConvertibility } from "@/lib/api/plan-adapters";
import type { AssetDisposition } from "@/types/plan";
import { isValidGAddress } from "@/lib/utils/validation";
import { cn } from "@/lib/utils/cn";

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
  const transferReady = isTransfer && !!transferDestination && isValidGAddress(transferDestination);
  const resolved = item.convertible ? !isTransfer || transferReady : isIssuer || transferReady;

  const transferPanel = (
    <div className="mt-3 pl-7">
      <label className="flex cursor-pointer items-start gap-2 text-xs text-white/70">
        <input
          type="checkbox"
          checked={isTransfer}
          onChange={(e) =>
            // Leaving the transfer option returns the asset to its default: the swap when one
            // exists, otherwise unresolved, so a non-convertible asset cannot silently fall
            // back to being burned.
            onSetDisposition(item.asset, e.target.checked ? "transfer" : "convert")
          }
          className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-stellar"
        />
        <span>
          Send my {item.balance} {item.code} to another account instead.{" "}
          <span className="text-white/40">You keep the tokens.</span>
        </span>
      </label>

      {isTransfer && (
        <div className="mt-2 space-y-1.5">
          <input
            type="text"
            value={transferDestination ?? ""}
            onChange={(e) => onSetTransferDestination(item.asset, e.target.value || null)}
            placeholder={`G... (an account that already holds ${item.code})`}
            spellCheck={false}
            aria-label={`Destination account for ${item.code}`}
            className={cn(
              "w-full rounded-md border bg-black/30 px-2.5 py-1.5 font-mono text-xs text-white",
              "placeholder:font-sans placeholder:text-white/30 focus:outline-none",
              transferDestination && !isValidGAddress(transferDestination)
                ? "border-destructive/50 focus:border-destructive"
                : "border-white/10 focus:border-stellar/50"
            )}
          />
          {/* A shortcut, not a constraint: the API takes any address per asset, and hiding that
              behind a single fixed destination would make the UI narrower than the contract. */}
          {mergeDestination && transferDestination !== mergeDestination && (
            <button
              type="button"
              onClick={() => onSetTransferDestination(item.asset, mergeDestination)}
              className="text-[0.7rem] text-stellar/90 underline-offset-2 hover:underline"
            >
              Use the same account I&apos;m merging into
            </button>
          )}
          <p className="text-[0.7rem] leading-relaxed text-white/45">
            That account must already hold a {item.code} trustline — LumenWipe cannot add one for
            it, and the whole close fails if it cannot receive the balance.
          </p>
        </div>
      )}
    </div>
  );

  if (item.convertible) {
    return (
      <div
        className={cn(
          "rounded-lg border p-3 transition-colors",
          resolved
            ? "border-emerald-500/20 bg-emerald-500/5"
            : "border-amber-500/30 bg-amber-500/[0.06]"
        )}
      >
        <div className="flex items-center gap-3">
          {isTransfer ? (
            <Send className="h-4 w-4 shrink-0 text-white/50" />
          ) : (
            <ArrowRightLeft className="h-4 w-4 shrink-0 text-emerald-400" />
          )}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-white">
              {item.code} <span className="text-white/40">→</span>{" "}
              {isTransfer ? "another account" : "XLM"}
            </p>
            <p className="text-xs text-white/50">
              {isTransfer
                ? `${item.balance} ${item.code} will be sent as ${item.code}, not swapped.`
                : `${item.balance} ${item.code} will be swapped to XLM on the DEX.`}
            </p>
          </div>
          <span
            className={cn(
              "shrink-0 rounded-full border px-2 py-0.5 text-[0.65rem] font-medium uppercase tracking-wide",
              isTransfer
                ? "border-white/20 bg-white/5 text-white/70"
                : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
            )}
          >
            {isTransfer ? "Send" : "Swap"}
          </span>
        </div>
        {transferPanel}
      </div>
    );
  }

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
            {item.code} <span className="text-white/40">·</span>{" "}
            <span className="text-amber-300/90">no swap route on the DEX</span>
          </p>
          <p className="mt-1 text-xs leading-relaxed text-white/55">
            There is no way to swap your {item.balance} {item.code} to XLM. A trustline with a
            balance cannot be removed, so the account cannot be closed while this balance remains.
            You can send these tokens to another account that holds them, or return them to the
            issuer and give them up.
          </p>
        </div>
      </div>

      <div className="mt-3 pl-7">
        <label className="flex cursor-pointer items-start gap-2 text-xs text-white/70">
          <input
            type="checkbox"
            checked={isIssuer}
            onChange={(e) => onSetDisposition(item.asset, e.target.checked ? "issuer" : "convert")}
            disabled={isTransfer}
            className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-stellar disabled:opacity-40"
          />
          <span className={cn(isTransfer && "text-white/30")}>
            Return my {item.balance} {item.code} to the issuer.{" "}
            <span className="text-white/40">You give up these tokens.</span>
          </span>
        </label>
      </div>
      {transferPanel}
    </div>
  );
}
