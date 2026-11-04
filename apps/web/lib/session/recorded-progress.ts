import type { SessionRecord } from "@/types/session";

/** How far a saved close got, as this browser recorded it: never the account's own state, which
 *  another tab or device may have moved further. */
export function recordedProgress(record: SessionRecord): { confirmed: number; text: string } {
  if (record.stepCount !== null) {
    const confirmed = record.currentStepIndex;
    return {
      confirmed,
      text: `${confirmed} of ${record.stepCount} ${record.stepCount === 1 ? "step" : "steps"} confirmed, as recorded in this browser`,
    };
  }
  const confirmed = record.completedSteps.length;
  return {
    confirmed,
    text: `${confirmed} confirmed ${confirmed === 1 ? "transaction" : "transactions"}, as recorded in this browser`,
  };
}

/** The one-time notice for a close whose execute page lost its plan to a reload. It never says
 *  nothing was sent: the record is written before anything is signed, so it cannot show that. */
export function interruptedCloseNotice(record: SessionRecord): string {
  const progress = recordedProgress(record);
  if (progress.confirmed > 0) {
    return `The page was reloaded while this close was running: ${progress.text}. Confirmed work stays confirmed on the network, and you can continue below: resuming reads the account again first.`;
  }
  return "The page was reloaded while this close was running. This browser recorded no confirmed step, but a transaction may have been in flight. Resuming reads the account again first, so it shows what actually happened before anything is signed.";
}
