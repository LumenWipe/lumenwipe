"use client";

import { useId, useState, type ReactElement } from "react";
import { cn } from "@/lib/utils/cn";
import { shortAddr, shortHash } from "@/lib/utils/short-id";
import { CopyButton } from "./copy-button";

interface IdentifierDisplayProps {
  /** Copied and revealed exactly as given. */
  value: string;
  kind: "address" | "hash";
  /** What the value is, for the buttons' accessible names, e.g. "destination address". */
  label: string;
  className?: string;
}

/** An address or a transaction hash: shortened by default, revealed in full on request, and
 *  copyable either way. The one way the receipt and the history show either. */
export function IdentifierDisplay({
  value,
  kind,
  label,
  className,
}: IdentifierDisplayProps): ReactElement {
  const [revealed, setRevealed] = useState(false);
  const id = useId();
  const short = kind === "hash" ? shortHash(value) : shortAddr(value);
  const shortens = short.length < value.length;

  return (
    <span
      className={cn("inline-flex min-w-0 max-w-full flex-wrap items-center gap-x-1", className)}
    >
      <span id={id} className="min-w-0 break-all font-mono-address">
        {revealed || !shortens ? (
          value
        ) : (
          <>
            <span className="print:hidden">{short}</span>
            {/* On paper nothing can be revealed or copied: the whole value is printed. */}
            <span data-print-only>{value}</span>
          </>
        )}
      </span>
      {shortens && (
        <button
          type="button"
          aria-expanded={revealed}
          aria-controls={id}
          onClick={() => setRevealed((r) => !r)}
          className="rounded text-xs text-accent hover:underline print:hidden focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          {revealed ? "Shorten" : "Show full"}
          <span className="sr-only"> {label}</span>
        </button>
      )}
      <span className="contents print:hidden">
        <CopyButton value={value} label={label} />
      </span>
    </span>
  );
}
