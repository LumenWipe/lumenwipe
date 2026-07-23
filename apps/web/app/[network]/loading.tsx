import { Loader2 } from "lucide-react";

export default function NetworkLoading() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin text-stellar/50" />
    </div>
  );
}
