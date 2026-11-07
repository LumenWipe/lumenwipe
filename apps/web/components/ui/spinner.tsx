import type { ReactElement } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils/cn";

interface SpinnerProps {
  /** Read by assistive technology in place of the animation. */
  label: string;
  className?: string;
}

export function Spinner({ label, className }: SpinnerProps): ReactElement {
  return (
    <>
      <Loader2
        aria-hidden="true"
        className={cn("h-4 w-4 motion-safe:animate-spin text-accent", className)}
      />
      <span className="sr-only">{label}</span>
    </>
  );
}
