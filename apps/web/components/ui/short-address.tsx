import type { ReactElement } from "react";
import { cn } from "@/lib/utils/cn";
import { CopyButton } from "./copy-button";

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
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      <span className="font-mono-address" title={value}>
        {shortenAddress(value)}
      </span>
      <CopyButton value={value} label={label} />
    </span>
  );
}
