"use client";

import { useState, type ReactElement } from "react";
import { Check, Copy } from "lucide-react";

interface CopyButtonProps {
  /** Copied exactly as given. */
  value: string;
  /** What the value is, for the accessible name, e.g. "issuer address". */
  label: string;
}

/** A button that copies `value`, and says whether that worked. */
export function CopyButton({ value, label }: CopyButtonProps): ReactElement {
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
    <>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy ${label}`}
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-subtle hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
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
    </>
  );
}
