"use client";

import { useState, type ReactElement } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils/cn";

interface ShortAddressProps {
  /** The full address or contract id; the copy button copies all of it. */
  value: string;
  /** What the value is, for the copy button's accessible name, e.g. "issuer address". */
  label: string;
  className?: string;
}

export function shortenAddress(value: string): string {
  return value.length > 8 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value;
}

/** An address shortened to its first and last four characters, with a button that copies it. */
export function ShortAddress({ value, label, className }: ShortAddressProps): ReactElement {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
  };

  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      <span className="font-mono-address" title={value}>
        {shortenAddress(value)}
      </span>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy ${label}`}
        className="inline-flex h-6 w-6 items-center justify-center rounded text-fg-subtle hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        {status === "copied" ? (
          <Check className="h-3.5 w-3.5" aria-hidden />
        ) : (
          <Copy className="h-3.5 w-3.5" aria-hidden />
        )}
      </button>
      <span role="status" className="sr-only">
        {status === "copied"
          ? `Copied the ${label}.`
          : status === "failed"
            ? `Could not copy the ${label}.`
            : ""}
      </span>
    </span>
  );
}
