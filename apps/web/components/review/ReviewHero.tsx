import { ExternalLink } from "lucide-react";
import { SE_EXPLORER_BASE, type Network } from "@/config/networks";
import type { ExpectedReceive } from "@/lib/plan/expected-receive";
import { memoSegments, type DestinationKind, type MemoLine } from "@/lib/plan/destination-kind";
import { FEES_EXCEED_BALANCE, receiveFigure } from "@/components/plan/ExpectedReceiveBreakdown";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FullAddress } from "@/components/ui/full-address";

interface ReviewHeroProps {
  network: Network;
  source: string;
  destination: string;
  kind: DestinationKind;
  memo: MemoLine;
  /** Null when the plan carried no usable fee estimate. */
  expected: ExpectedReceive | null;
}

function ExplorerLink({
  network,
  address,
  label,
}: {
  network: Network;
  address: string;
  label: string;
}) {
  return (
    <Button asChild variant="ghost" size="sm">
      <a
        href={`${SE_EXPLORER_BASE[network]}/account/${address}`}
        target="_blank"
        rel="noopener noreferrer"
      >
        <ExternalLink className="h-3.5 w-3.5" aria-hidden />
        Explorer<span className="sr-only">: the {label} on Stellar Expert</span>
      </a>
    </Button>
  );
}

/** The memo exactly as it goes on chain, isolated from the text around it. A control or format
 *  character is shown as its code point, and a text memo carries its byte count. */
export function MemoValue({ memo }: { memo: MemoLine }) {
  if (memo.value === null) return <>none</>;
  return (
    <>
      {memo.label}:{" "}
      <bdi className="font-mono-address whitespace-pre-wrap break-all">
        {memoSegments(memo.value).map((segment, i) =>
          segment.escaped ? (
            <span key={i} className="text-warning" data-testid="memo-escape">
              {segment.text}
            </span>
          ) : (
            <span key={i}>{segment.text}</span>
          )
        )}
      </bdi>
      {memo.bytes !== null && (
        <span className="text-xs text-fg-subtle">
          {" "}
          ({memo.bytes} {memo.bytes === 1 ? "byte" : "bytes"})
        </span>
      )}
    </>
  );
}

function kindLine(kind: DestinationKind): string {
  switch (kind.kind) {
    case "exchange":
      if (kind.route === "refused") {
        return `Recognized exchange: ${kind.name}. It needs LumenWipe's shared relay account, which the exchange list in this browser does not allow for it, so this close will not be signed.`;
      }
      return [
        `Recognized exchange: ${kind.name}`,
        kind.memoRequired ? "deposit memo required" : "no deposit memo required",
        kind.route === "relay"
          ? "sent through LumenWipe's shared relay account within the same close."
          : "sent straight to the exchange.",
      ].join(", ");
    case "confirmed-wallet":
      return "A wallet you confirmed you control. If this is an exchange, the funds will be lost.";
    case "wallet":
      return "LumenWipe does not recognize this address as an exchange. If it is one, the funds will be lost.";
  }
}

/** The facts the consent is about, first: who is closed, where the balance goes, with what memo
 *  and how much. Every value is the user's own input. */
export default function ReviewHero({
  network,
  source,
  destination,
  kind,
  memo,
  expected,
}: ReviewHeroProps) {
  return (
    <Card className="space-y-4 p-4" data-testid="review-hero">
      <div>
        <p className="text-xs text-fg-subtle">You are closing</p>
        <div className="flex flex-wrap items-center gap-x-2">
          <FullAddress
            value={source}
            label="account being closed"
            className="text-sm text-white/80"
          />
          <ExplorerLink network={network} address={source} label="account being closed" />
        </div>
      </div>

      <div>
        <p className="text-xs text-fg-subtle">You are sending to</p>
        <div className="flex flex-wrap items-center gap-x-2">
          <FullAddress
            value={destination}
            label="destination address"
            className="text-sm text-white"
          />
          <ExplorerLink network={network} address={destination} label="destination" />
        </div>
        <p className="mt-1 text-xs text-fg-muted" data-testid="destination-kind">
          {kindLine(kind)}
        </p>
        {kind.kind === "exchange" && (
          <p className="text-xs text-fg-subtle">Exchange list last checked {kind.lastVerified}.</p>
        )}
      </div>

      <dl className="text-sm">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <dt className="text-fg-subtle">Memo</dt>
          <dd className="min-w-0 text-white/80" data-testid="memo-line">
            <MemoValue memo={memo} />
          </dd>
        </div>
      </dl>

      <div data-testid="hero-receive">
        {expected ? (
          <p className="text-sm text-fg-muted">
            You will receive about{" "}
            <span className="mkt-display block text-3xl font-bold text-value">
              {receiveFigure(expected).xlm} XLM
            </span>
            {receiveFigure(expected).feesExceed && (
              <span className="mt-1 block text-warning">{FEES_EXCEED_BALANCE}</span>
            )}
          </p>
        ) : (
          <p className="text-sm text-fg-muted">
            The amount you will receive could not be estimated for this plan.
          </p>
        )}
      </div>
    </Card>
  );
}
