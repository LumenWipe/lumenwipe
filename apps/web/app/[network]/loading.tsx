import { Loader2 } from "lucide-react";

export default function NetworkLoading() {
  return (
    <div role="status" className="flex min-h-[60vh] items-center justify-center">
      <Loader2 aria-hidden="true" className="h-6 w-6 animate-spin text-stellar/50" />
      <span className="sr-only">Loading</span>
    </div>
  );
}
