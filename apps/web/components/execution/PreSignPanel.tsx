"use client";

import type { ReactElement } from "react";
import { Card } from "@/components/ui/card";
import { hashFingerprint, type SigningPrompt } from "@/lib/execution/signing-prompt";
import { signingGuidance } from "@/lib/wallet-kit/signing-guidance";

/**
 * Beside a wallet's prompt: what that wallet is being asked to sign, read from the very envelope
 * handed to it, so the user can compare the two before approving.
 */
export default function PreSignPanel({ prompt }: { prompt: SigningPrompt }): ReactElement {
  return (
    <Card data-testid="pre-sign-panel" className="flex flex-col gap-2 p-4 text-sm">
      <p className="font-medium text-fg">What your wallet is asking you to sign</p>
      <p className="text-fg-muted">{signingGuidance(prompt.walletId)}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        {prompt.summary && (
          <>
            <dt className="text-fg-subtle">Destination</dt>
            {prompt.summary.mergeDestination ? (
              <dd
                data-testid="pre-sign-destination"
                className="font-mono-address break-all text-fg"
              >
                {prompt.summary.mergeDestination}
              </dd>
            ) : (
              <dd data-testid="pre-sign-destination" className="text-fg">
                No account merge in this transaction
              </dd>
            )}
            <dt className="text-fg-subtle">Operations</dt>
            <dd data-testid="pre-sign-operations" className="text-fg">
              {prompt.summary.operationCount}
            </dd>
          </>
        )}
        <dt className="text-fg-subtle">Transaction hash</dt>
        <dd data-testid="pre-sign-hash" className="font-mono text-fg">
          {hashFingerprint(prompt.hash)}
        </dd>
      </dl>
      <p className="text-xs text-fg-subtle">
        If your wallet shows a transaction hash, it starts and ends with these characters.
      </p>
    </Card>
  );
}
