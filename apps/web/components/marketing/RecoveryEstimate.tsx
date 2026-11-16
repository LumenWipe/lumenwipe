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
import { formatDate } from "@/lib/i18n/format";
import { SITE_LOCALE } from "@/lib/i18n/locale";
import { HERO } from "@/lib/i18n/messages/hero";

const T = HERO[SITE_LOCALE].estimate;

export const ESTIMATE_CAVEAT = T.caveat;

type Read =
  { kind: "pending" } | { kind: "ready"; estimate: Estimate } | { kind: "failed"; message: string };

function rangeText({ lowStroops, highStroops }: Estimate["range"]): string {
  const low = formatXlmDown(lowStroops);
  const high = formatXlmDown(highStroops);
  return low === high ? T.about(low) : T.range(low, high);
}

/** The assumptions behind the figures, each shown only when it applies to this read. */
function assumptions(range: Estimate["range"]): string[] {
  const lines = [T.assumptions.low, T.assumptions.high, T.assumptions.exchangeFee];
  if (range.unquotedSwaps > 0) {
    lines.push(T.assumptions.unquoted(range.unquotedSwaps));
  }
  if (range.unconvertibleAssets > 0) {
    lines.push(T.assumptions.unconvertible(range.unconvertibleAssets));
  }
  if (range.leavesOutDefiExits) {
    lines.push(T.assumptions.defiExits);
  }
  return lines;
}

/** The sentence the hero's live region reads for this outcome. */
export function estimateAnnouncement(read: Read): string {
  if (read.kind === "pending") return T.readingAnnouncement;
  if (read.kind === "failed") return read.message;
  const { range } = read.estimate;
  return T.announcement(rangeText(range), T.blockers(range.blockers), ESTIMATE_CAVEAT);
}

function readTime(readAt: string): string {
  return formatDate(SITE_LOCALE, readAt, { hour: "2-digit", minute: "2-digit" });
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
        {T.heading}
      </h2>

      {read.kind === "pending" && <p className="mt-2 text-sm text-fg-muted">{T.reading}</p>}

      {read.kind === "failed" && <p className="mt-2 text-sm text-fg-muted">{read.message}</p>}

      {read.kind === "ready" && (
        <>
          <p className="mkt-display mt-2 text-2xl font-bold text-value">
            {rangeText(read.estimate.range)}
          </p>
          <p className="mt-1 text-xs text-fg-subtle">
            {T.readAt(
              <time dateTime={read.estimate.readAt}>{readTime(read.estimate.readAt)}</time>
            )}
          </p>
          <p className="mt-3 text-sm font-medium text-white">{ESTIMATE_CAVEAT}</p>
          <p className="mt-2 text-sm text-fg-muted">{T.blockers(read.estimate.range.blockers)}</p>
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
          className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-accent hover:underline"
        >
          {T.continue}
          <ArrowRight className="h-4 w-4" />
        </button>
      )}
    </section>
  );
}
