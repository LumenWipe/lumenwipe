import { Spinner } from "@/components/ui/spinner";
import { stepperSurface } from "@/components/ui/stepper";
import { cn } from "@/lib/utils/cn";

interface ProgressIndicatorProps {
  status: string;
}

export default function ProgressIndicator({ status }: ProgressIndicatorProps) {
  return (
    <div className={cn(stepperSurface, "flex items-center gap-2.5 text-sm text-white/60")}>
      <Spinner label="In progress" className="shrink-0" />
      {/* The wizard's status region already carries this text for assistive technology. */}
      <span aria-hidden="true">{status}</span>
    </div>
  );
}
