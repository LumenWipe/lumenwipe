"use client";

import { Clock } from "lucide-react";
import { STILL_UNCONFIRMED_NOTICE, UNCONFIRMED_NOTICE } from "@/lib/utils/user-error";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";

interface UnconfirmedPanelProps {
  hash: string;
  stillUnconfirmed: boolean;
  onCheck: () => void;
}

/** A transaction whose outcome is unknown: not failed, not done, and nothing to sign or retry. */
export default function UnconfirmedPanel({
  hash,
  stillUnconfirmed,
  onCheck,
}: UnconfirmedPanelProps) {
  return (
    <div className="flex flex-col gap-3" data-testid="unconfirmed-panel">
      <Callout tone="warning" announce="status" icon={<Clock className="h-4 w-4" />}>
        {stillUnconfirmed ? STILL_UNCONFIRMED_NOTICE : UNCONFIRMED_NOTICE}
      </Callout>
      <p className="text-xs text-fg-subtle">
        Transaction hash: <span className="font-mono break-all text-white/70">{hash}</span>
      </p>
      <Button onClick={onCheck} className="w-full">
        Check again
      </Button>
    </div>
  );
}
