import type { ReactElement, ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils/cn";

interface ExplorerLinkProps {
  href: string;
  /** The visible name, e.g. "Stellar Expert". */
  children: ReactNode;
  /** What the link opens, for its accessible name, e.g. "transaction 3f2a1b…9c1d0e". */
  target: string;
  className?: string;
}

/** A link to a public explorer, in a new tab. Its accessible name says what it opens and that it
 *  opens a new tab, after the visible name. */
export function ExplorerLink({
  href,
  children,
  target,
  className,
}: ExplorerLinkProps): ReactElement {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "inline-flex items-center gap-1 text-xs text-accent hover:underline",
        className
      )}
    >
      {children}
      <span className="sr-only"> - {target}, opens in a new tab</span>
      <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
    </a>
  );
}
