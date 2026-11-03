"use client";

import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { NETWORK_LABELS, type Network } from "@/config/networks";
import { recordedProgress } from "@/lib/session/recorded-progress";
import type { SessionRecord } from "@/types/session";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";

export const DISCARD_RECORD =
  "This deletes only this browser's saved record of the close. Your account on the network is not touched, and you can still start a close for it again.";
export const RESUME_EXPLAINED =
  "Resuming reads the account again and goes through analyze and review again, so you confirm the destination before anything is signed.";

function short(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-6)}`;
}

/** When the close started, in the reader's own locale and time zone. */
export function formatStartedAt(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(iso)
  );
}

interface ResumeBannerProps {
  session: SessionRecord;
  network: Network;
  /** A transaction of this close has an outcome nobody has settled yet. */
  unconfirmed: boolean;
  checking: boolean;
  onCheck: () => void;
  onResume: () => void;
  onDiscard: () => void;
}

/** The saved close this browser holds, with what it knows about it and the two ways on. */
export default function ResumeBanner({
  session,
  network,
  unconfirmed,
  checking,
  onCheck,
  onResume,
  onDiscard,
}: ResumeBannerProps) {
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  return (
    <section
      aria-labelledby="resume-banner-title"
      className="mb-6 rounded-lg border border-accent/30 bg-accent/10 px-4 py-3 text-sm"
    >
      <h2 id="resume-banner-title" className="flex items-center gap-2 font-medium text-white">
        <RotateCcw aria-hidden="true" className="h-4 w-4 shrink-0 text-accent" />A close you started
        is saved in this browser
      </h2>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-fg-muted">
        <dt>Account</dt>
        <dd className="font-mono text-xs leading-5">{short(session.sourceAddress)}</dd>
        <dt>Destination</dt>
        <dd className="min-w-0">
          <details>
            <summary className="cursor-pointer font-mono text-xs leading-5">
              {short(session.destinationAddress)}
              <span className="ml-2 font-sans text-accent">Show the full address</span>
            </summary>
            <p className="mt-1 break-all font-mono text-xs">{session.destinationAddress}</p>
            {session.memo && <p className="mt-1 text-xs">Memo: {session.memo}</p>}
          </details>
        </dd>
        <dt>Network</dt>
        <dd>{NETWORK_LABELS[network]}</dd>
        <dt>Started</dt>
        <dd>
          <time dateTime={session.createdAt}>{formatStartedAt(session.createdAt)}</time>
        </dd>
        <dt>Progress</dt>
        <dd>{recordedProgress(session).text}</dd>
      </dl>
      {!unconfirmed && <p className="mt-2 text-fg-muted">{RESUME_EXPLAINED}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        {unconfirmed ? (
          <Button type="button" size="sm" onClick={onCheck} disabled={checking}>
            Check again
          </Button>
        ) : (
          <>
            <Button type="button" size="sm" onClick={onResume}>
              Resume this close
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setConfirmingDiscard(true)}
            >
              Discard this record
            </Button>
          </>
        )}
      </div>
      {confirmingDiscard && (
        <Dialog onClose={() => setConfirmingDiscard(false)}>
          <div className="space-y-2 px-5 pt-5">
            <DialogTitle className="text-base font-semibold text-white">
              Discard this record?
            </DialogTitle>
            <DialogDescription className="text-sm text-fg-muted">
              {DISCARD_RECORD}
            </DialogDescription>
          </div>
          <DialogFooter className="px-5 py-4 sm:justify-end">
            <Button type="button" variant="secondary" onClick={() => setConfirmingDiscard(false)}>
              Keep the record
            </Button>
            <Button
              type="button"
              variant="danger"
              onClick={() => {
                setConfirmingDiscard(false);
                onDiscard();
              }}
            >
              Discard
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </section>
  );
}
