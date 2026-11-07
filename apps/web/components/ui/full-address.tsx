import type { ReactElement } from "react";
import { cn } from "@/lib/utils/cn";
import { CopyButton } from "./copy-button";

interface FullAddressProps {
  value: string;
  /** What the value is, for the copy button's accessible name, e.g. "destination address". */
  label: string;
  className?: string;
}

/** The address in groups of four, every character kept, so a substitution anywhere shows. */
export function groupAddress(address: string): string[] {
  return address.match(/.{1,4}/g) ?? [address];
}

/**
 * An address shown whole, in groups of four, with a button that copies it.
 *
 * The groups are spaced by margin, not by spaces, so selecting and copying them gives the address
 * as it is. A screen reader is given the address once, as one string, instead of the groups.
 */
export function FullAddress({ value, label, className }: FullAddressProps): ReactElement {
  return (
    <span className={cn("inline-flex max-w-full items-center gap-1 align-middle", className)}>
      <span className="font-mono-address min-w-0">
        <span className="sr-only select-none">{value}</span>
        <span aria-hidden="true" className="inline-flex flex-wrap gap-x-[0.5ch]">
          {groupAddress(value).map((group, i) => (
            <span key={i}>{group}</span>
          ))}
        </span>
      </span>
      <CopyButton value={value} label={label} />
    </span>
  );
}
