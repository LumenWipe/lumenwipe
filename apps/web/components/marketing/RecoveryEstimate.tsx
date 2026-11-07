"use client";

import { useEffect, useId, useState } from "react";
import { ArrowRight } from "lucide-react";
import type { Network } from "@/config/networks";
import {
  EstimateError,
  fetchEstimate,
  formatXlmDown,
  type RecoveryEstimate as Estimate,
} from "@/lib/api/estimate-client";

export const ESTIMATE_CAVEAT = "Estimate, not a promise: fees and market quotes change";

type Read =
  { kind: "pending" } | { kind: "ready"; estimate: Estimate } | { kind: "failed"; message: string };

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function rangeText({ lowStroops, highStroops }: Estimate["range"]): string {
  const low = formatXlmDown(lowStroops);
  const high = formatXlmDown(highStroops);
  return low === high ? `About ${low} XLM` : `${low} to ${high} XLM`;
}

function blockerText(blockers: number): string {
  return blockers === 0
    ? "No items found that would block a close."
    : `${count(blockers, "item", "items")} would block a close until resolved.`;
}

/** The assumptions behind the figures, each shown only when it applies to this read. */
function assumptions(range: Estimate["range"]): string[] {
  const lines = [
    "Low: the XLM balance less estimated network fees, with no conversions.",
    "High: adds the minimum quoted for converting other assets to XLM, and any XLM claimable balances. Quotes move with the market.",
    "Fees include the extra network fee an exchange destination needs.",
  ];
  if (range.unquotedSwaps > 0) {
    lines.push(`${count(range.unquotedSwaps, "asset", "assets")} had no quote and count as zero.`);
  }
  if (range.unconvertibleAssets > 0) {
    lines.push(
      `${count(range.unconvertibleAssets, "asset has", "assets have")} no route to XLM and ${range.unconvertibleAssets === 1 ? "is" : "are"} not counted.`
    );
  }
  if (range.tokenSwaps > 0) {
    lines.push("Token conversions pay a network fee the high figure does not include.");
  }
  if (range.leavesOutDefiExits) {
    lines.push("XLM paid out by exiting DeFi positions is not counted.");
  }
  return lines;
}

/** The sentence the hero's live region reads for this outcome. */
export function estimateAnnouncement(read: Read): string {
  if (read.kind === "pending") return "Reading the account.";
  if (read.kind === "failed") return read.message;
  const { range } = read.estimate;
  return `Estimated recovery: ${rangeText(range)}. ${blockerText(range.blockers)} ${ESTIMATE_CAVEAT}.`;
}

function readTime(readAt: string): string {
  return new Date(readAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * The read-only recovery estimate for one address, loaded only once a visitor asks for one. It
 * reads the account once per mount, keeps the address in memory only, and never navigates: the
 * close starts only from "Continue to close".
 */
export default function RecoveryEstimate({
  address,
  network,
  onAnnounce,
  onContinue,
}: {
  address: string;
  network: Network;
  onAnnounce: (text: string) => void;
  onContinue: () => void;
}) {
  const headingId = useId();
  const [read, setRead] = useState<Read>({ kind: "pending" });

  useEffect(() => {
    const controller = new AbortController();
    setRead({ kind: "pending" });
    fetchEstimate(network, address, controller.signal).then(
      (estimate) => setRead({ kind: "ready", estimate }),
      (e: unknown) => {
        if (controller.signal.aborted) return;
        const message = e instanceof EstimateError ? e.message : String(e);
        setRead({ kind: "failed", message });
      }
    );
    return () => controller.abort();
  }, [address, network]);

  useEffect(() => {
    onAnnounce(estimateAnnouncement(read));
  }, [read, onAnnounce]);

  return (
    <section
      aria-labelledby={headingId}
      aria-busy={read.kind === "pending"}
      className="mt-4 rounded-2xl border border-line-strong bg-white/[0.03] p-5 text-left"
    >
      <h2 id={headingId} className="text-sm font-semibold text-white">
        Recovery estimate
      </h2>

      {read.kind === "pending" && (
        <p className="mt-2 text-sm text-fg-muted">Reading the account…</p>
      )}

      {read.kind === "failed" && <p className="mt-2 text-sm text-fg-muted">{read.message}</p>}

      {read.kind === "ready" && (
        <>
          <p className="mkt-display mt-2 text-2xl font-bold text-value">
            {rangeText(read.estimate.range)}
          </p>
          <p className="mt-1 text-xs text-fg-subtle">
            Read at <time dateTime={read.estimate.readAt}>{readTime(read.estimate.readAt)}</time>{" "}
            from the public ledger. No wallet, no signing.
          </p>
          <p className="mt-3 text-sm font-medium text-white">{ESTIMATE_CAVEAT}</p>
          <p className="mt-2 text-sm text-fg-muted">{blockerText(read.estimate.range.blockers)}</p>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-fg-muted">
            {assumptions(read.estimate.range).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </>
      )}

      {read.kind !== "pending" && (
        <button
          type="button"
          onClick={onContinue}
          className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-value hover:underline"
        >
          Continue to close
          <ArrowRight className="h-4 w-4" />
        </button>
      )}
    </section>
  );
}
