"use client";

import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { busyRetryNotice } from "@/lib/utils/user-error";

interface BusyRetryNoticeProps {
  seconds: number | null;
  onStop: () => void;
}

/** The wait before an automatic retry, which the user can stop to get the busy answer now. */
export default function BusyRetryNotice({ seconds, onStop }: BusyRetryNoticeProps) {
  if (seconds === null) return null;
  return (
    <Callout
      tone="info"
      announce="status"
      data-testid="busy-retry"
      action={
        <Button variant="secondary" size="sm" onClick={onStop}>
          Stop waiting
        </Button>
      }
    >
      {busyRetryNotice(seconds)}
    </Callout>
  );
}
