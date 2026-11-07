import { ExternalLink } from "lucide-react";
import { explorerTxUrl, isValidNetwork } from "@/config/networks";
import type { ReceivedState } from "@/hooks/useReceivedLumens";
import { formatLumensExact } from "@/lib/utils/amounts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FullAddress } from "@/components/ui/full-address";
import type { ReceiptRecord } from "@/types/history";

interface ReceiptHeadlineProps {
  record: ReceiptRecord;
  received: ReceivedState;
  onRetry: () => void;
}

/** What a closed receipt leads with: the XLM the destination received, and where it went. */
export default function ReceiptHeadline({ record, received, onRetry }: ReceiptHeadlineProps) {
  return (
    <Card className="space-y-4 p-4">
      <div aria-live="polite">
        <Amount record={record} received={received} onRetry={onRetry} />
      </div>
      <div className="space-y-1.5">
        <p className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
          Destination
          {record.mediatorRequired && <Badge>via relay account</Badge>}
        </p>
        <FullAddress
          value={record.destinationAddress}
          label="destination address"
          className="text-sm text-white/85"
        />
      </div>
    </Card>
  );
}

function Amount({ record, received, onRetry }: ReceiptHeadlineProps) {
  if (received.state === "loading") {
    return <p className="text-sm text-fg-muted">Reading the amount received…</p>;
  }
  if (received.state === "unavailable" || received.state === "failed") {
    return (
      <div className="space-y-2">
        <p className="text-sm font-medium text-white/85">
          Amount not available - check the transaction on the explorer
        </p>
        <ul className="space-y-1">
          {received.hashes.map((hash) => (
            <li key={hash}>
              {/* A record naming no known network has no explorer to link to: the hash alone. */}
              {isValidNetwork(record.network) ? (
                <a
                  href={explorerTxUrl(record.network, hash)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex max-w-full items-start gap-1 break-all font-mono-address text-xs text-accent hover:underline"
                >
                  {hash}
                  <ExternalLink className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                  <span className="sr-only">(opens in a new tab)</span>
                </a>
              ) : (
                <span className="break-all font-mono-address text-xs text-white/85">{hash}</span>
              )}
            </li>
          ))}
        </ul>
        {received.state === "failed" && (
          <Button size="sm" variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        )}
      </div>
    );
  }
  const amount = received.state === "recorded" ? formatLumensExact(received.lumens) : null;
  if (amount === null) {
    return <p className="text-sm text-fg-muted">Amount received: not recorded</p>;
  }
  return <p className="mkt-display text-2xl font-bold text-value">Received {amount} XLM</p>;
}
