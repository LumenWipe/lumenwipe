"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

/** A native, keyboard-ready section that folds away. It opens itself when `autoOpen` turns true
 *  (a shared link restoring a hand-picked selection, say) and never closes on its own: once open,
 *  only the visitor closes it. */
export default function Disclosure({
  label,
  hint,
  defaultOpen = false,
  autoOpen = false,
  className = "",
  children,
}: {
  label: ReactNode;
  /** A short summary shown beside the label while folded, e.g. "4 on". */
  hint?: ReactNode;
  /** Open on first render only. */
  defaultOpen?: boolean;
  autoOpen?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(autoOpen || defaultOpen);

  // Adjusted during render rather than in an effect, so the open state lands in the same paint.
  const [wasAutoOpen, setWasAutoOpen] = useState(autoOpen);
  if (autoOpen !== wasAutoOpen) {
    setWasAutoOpen(autoOpen);
    if (autoOpen) setOpen(true);
  }

  return (
    <details
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      className={`rounded-lg border border-white/10 bg-white/[0.02] ${className}`}
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-xs text-white/75 transition-colors hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-stellar [&::-webkit-details-marker]:hidden">
        <span className="font-semibold">{label}</span>
        <span className="flex items-center gap-2">
          {hint !== undefined && <span className="mkt-mono text-[10px] text-subtle">{hint}</span>}
          <ChevronDown
            aria-hidden
            className={`h-3.5 w-3.5 text-subtle transition-transform ${open ? "rotate-180" : ""}`}
          />
        </span>
      </summary>
      <div className="border-t border-white/10 px-3 py-3">{children}</div>
    </details>
  );
}
