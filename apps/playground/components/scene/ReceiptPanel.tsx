"use client";

import { useEffect, useId, useState } from "react";
import { Check, ExternalLink, Link2, ReceiptText, RotateCcw } from "lucide-react";
import { usePlaygroundStore, type BatchMember } from "@/store/playground";
import { txExplorerUrl } from "@/lib/explorer";
import { batchLink, selectionLink } from "@/lib/share-link";
import { formatStroops } from "@/lib/stroops";
import { isSettled, useReceipts, type ClientReceipt, type ReceiptRef } from "@/hooks/useReceipts";
import SdkSnippetPanel from "./SdkSnippetPanel";

const STROOPS_PER_XLM = BigInt(10_000_000);

const OPERATION_LABELS: Record<string, string> = {
  accountMerge: "Account merge",
  changeTrust: "Trustline change",
  manageData: "Data entry removal",
  manageSellOffer: "Offer change",
  manageBuyOffer: "Offer change",
  payment: "Payment",
  pathPaymentStrictSend: "Conversion to XLM",
  pathPaymentStrictReceive: "Conversion to XLM",
  setOptions: "Signer or threshold change",
  revokeSponsorship: "Sponsorship revoke",
  claimClaimableBalance: "Claimable balance claim",
  invokeHostFunction: "Contract call",
};

/** XLM with the trailing zeros of its seven decimals dropped. */
function xlm(stroops: bigint): string {
  const [whole, fraction = ""] = formatStroops(stroops).split(".");
  const trimmed = fraction.replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : `${whole}`;
}

const short = (address: string): string => `${address.slice(0, 4)}…${address.slice(-4)}`;

interface Totals {
  feeByAccount: bigint;
  feeBySponsor: bigint;
  merged: bigint | null;
  forwarded: { amount: bigint; memo: string | null } | null;
  destination: string | null;
  operations: Map<string, number>;
}

/** Sums settled receipts; null until every one of them is settled, so no total is ever partial. */
export function totalsOf(receipts: readonly ClientReceipt[]): Totals | null {
  if (receipts.length === 0 || !receipts.every(isSettled)) return null;
  const totals: Totals = {
    feeByAccount: BigInt(0),
    feeBySponsor: BigInt(0),
    merged: null,
    forwarded: null,
    destination: null,
    operations: new Map(),
  };
  for (const r of receipts) {
    if (r.status !== "read" && r.status !== "failed") continue;
    if (r.feePaidBy === "account") totals.feeByAccount += BigInt(r.feeStroops);
    else totals.feeBySponsor += BigInt(r.feeStroops);
    if (r.status !== "read") continue;
    for (const { type, count } of r.operations) {
      totals.operations.set(type, (totals.operations.get(type) ?? 0) + count);
    }
    if (!r.merge) continue;
    totals.merged = BigInt(r.merge.amountStroops);
    if (r.merge.into === "relay") {
      totals.forwarded = {
        amount: BigInt(r.merge.forwarded.amountStroops),
        memo: r.merge.forwarded.memo,
      };
    } else {
      totals.destination = r.merge.destination;
    }
  }
  return totals;
}

function useCopied(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);
  return [
    copied,
    (text) => {
      navigator.clipboard.writeText(text).then(
        () => setCopied(true),
        () => setCopied(false)
      );
    },
  ];
}

function FeeLine({ totals }: { totals: Totals }) {
  const parts: string[] = [];
  if (totals.feeByAccount > BigInt(0) || totals.feeBySponsor === BigInt(0)) {
    parts.push(`${xlm(totals.feeByAccount)} XLM paid by the demo account`);
  }
  if (totals.feeBySponsor > BigInt(0)) {
    parts.push(`${xlm(totals.feeBySponsor)} XLM paid by LumenWipe's fee sponsor`);
  }
  return <>{parts.join(", ")}</>;
}

function TxRows({ receipts }: { receipts: readonly ClientReceipt[] }) {
  return (
    <ul className="space-y-1 text-[11px]">
      {receipts.map((r) => (
        <li key={r.hash} className="flex items-center justify-between gap-2">
          <a
            href={txExplorerUrl(r.hash)}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Transaction ${r.hash.slice(0, 8)} in the explorer`}
            className="flex min-w-0 items-center gap-1 mkt-mono text-stellar hover:opacity-80"
          >
            {r.hash.slice(0, 8)}…
            <ExternalLink className="h-3 w-3 shrink-0" />
          </a>
          <span className="mkt-mono text-white/70">
            {r.status === "read"
              ? `fee ${xlm(BigInt(r.feeStroops))} XLM`
              : r.status === "failed"
                ? `failed on the ledger, fee ${xlm(BigInt(r.feeStroops))} XLM`
                : r.status === "loading" || r.status === "pending"
                  ? "reading from the ledger…"
                  : "not readable yet"}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Pending({ receipts, retry }: { receipts: readonly ClientReceipt[]; retry: () => void }) {
  const reading = receipts.some((r) => r.status === "loading");
  if (reading) {
    return <p className="text-xs text-white/70">Reading each transaction from the ledger…</p>;
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-white/70">
      <span>Not every transaction could be read from the ledger yet, so no total is shown.</span>
      <button
        onClick={retry}
        className="flex items-center gap-1 rounded border border-white/15 px-2 py-1 text-white/80 hover:bg-white/5"
      >
        <RotateCcw className="h-3 w-3" />
        Read again
      </button>
    </div>
  );
}

function Operations({ totals }: { totals: Totals }) {
  if (totals.operations.size === 0) return null;
  return (
    <ul aria-label="Operations by type" className="mt-2 space-y-0.5 text-[11px] text-white/70">
      {[...totals.operations].map(([type, count]) => (
        <li key={type}>
          {OPERATION_LABELS[type] ?? type}: {count}
        </li>
      ))}
    </ul>
  );
}

function SingleReceipt({ account, hashes }: { account: string; hashes: string[] }) {
  const refs: ReceiptRef[] = hashes.map((hash) => ({ account, hash }));
  const { receipts, retry } = useReceipts(refs);
  const reserve = usePlaygroundStore((s) => s.preCloseReserveXlm);
  const totals = totalsOf(receipts);
  return (
    <>
      {totals ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
          <dt className="text-subtle">Merged</dt>
          <dd className="text-white/85">
            {totals.merged === null ? (
              "No merge was read from these transactions"
            ) : (
              <>
                <span className="mkt-mono text-stellar">{xlm(totals.merged)} XLM</span>
                {totals.forwarded
                  ? `, through the exchange relay, which forwarded ${xlm(totals.forwarded.amount)} XLM${
                      totals.forwarded.memo ? ` with memo ${totals.forwarded.memo}` : ""
                    }`
                  : totals.destination
                    ? ` to ${short(totals.destination)}`
                    : ""}
                {reserve !== null && (
                  <span className="block text-white/70">
                    of which {reserve.toFixed(1)} XLM was the reserve the account held before the
                    close
                  </span>
                )}
              </>
            )}
          </dd>
          <dt className="text-subtle">Fees</dt>
          <dd className="text-white/85">
            <FeeLine totals={totals} />
          </dd>
        </dl>
      ) : (
        <Pending receipts={receipts} retry={retry} />
      )}
      {totals && <Operations totals={totals} />}
      <div className="mt-3">
        <TxRows receipts={receipts} />
      </div>
    </>
  );
}

function memberOutcome(member: BatchMember, receipts: readonly ClientReceipt[]): string {
  if (member.close === "closed") {
    const totals = totalsOf(receipts);
    if (!totals) return "Merged away; reading its transactions from the ledger…";
    const merged = totals.merged === null ? "no merge read" : `${xlm(totals.merged)} XLM merged`;
    return `${merged}, fees ${xlm(totals.feeByAccount + totals.feeBySponsor)} XLM`;
  }
  if (receipts.length === 0) {
    return member.close === "blocked"
      ? "Reported blocked before anything was sent: no close transaction, nothing merged"
      : "Stopped before any close transaction was sent: nothing merged";
  }
  const totals = totalsOf(receipts);
  const fees = totals ? `, fees ${xlm(totals.feeByAccount + totals.feeBySponsor)} XLM` : "";
  return `Left open, not merged${fees}`;
}

function BatchReceipt({ members }: { members: BatchMember[] }) {
  const refs: ReceiptRef[] = members.flatMap((m) =>
    m.hashes.map((hash) => ({ account: m.demoPublic, hash }))
  );
  const { receipts, retry } = useReceipts(refs);
  const totals = totalsOf(receipts);
  const starts = members.map((_, i) =>
    members.slice(0, i).reduce((total, m) => total + m.hashes.length, 0)
  );
  const rows = members.map((member, i) => ({
    member,
    own: receipts.slice(starts[i], starts[i]! + member.hashes.length),
  }));
  return (
    <>
      <ul aria-label="Each account's close" className="space-y-3 text-xs">
        {rows.map(({ member, own }) => (
          <li key={member.sessionId}>
            <p className="text-white/85">{member.label}</p>
            <p className="text-white/70">{memberOutcome(member, own)}</p>
            {own.length > 0 && (
              <div className="mt-1">
                <TxRows receipts={own} />
              </div>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-3">
        {totals ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
            <dt className="text-subtle">Fees in all</dt>
            <dd className="text-white/85">
              <FeeLine totals={totals} />
            </dd>
          </dl>
        ) : (
          receipts.length > 0 && <Pending receipts={receipts} retry={retry} />
        )}
      </div>
    </>
  );
}

/** What the close cost and carried, read from the confirmed transactions, with a share link and
 *  the same close in SDK code. */
export default function ReceiptPanel() {
  const titleId = useId();
  const demoPublic = usePlaygroundStore((s) => s.demoPublic);
  const log = usePlaygroundStore((s) => s.log);
  const batch = usePlaygroundStore((s) => s.batch);
  const batchSize = usePlaygroundStore((s) => s.batchSize);
  const selection = usePlaygroundStore((s) => s.selection);
  const [copied, copy] = useCopied();

  const hashes = log.flatMap((e) => (e.kind === "demolish" && e.txHash ? [e.txHash] : []));
  const share = (): string =>
    batch
      ? batchLink(window.location, batchSize === 3 ? 3 : 2)
      : selectionLink(window.location, selection);

  return (
    <section aria-labelledby={titleId} className="mkt-panel relative mt-6 rounded-lg p-4 sm:p-5">
      <h2 id={titleId} className="mkt-eyebrow mb-1.5 flex items-center gap-2 text-white/50">
        <ReceiptText className="h-3.5 w-3.5 text-stellar" />
        Receipt
      </h2>
      <p className="mb-3 text-xs leading-relaxed text-white/70">
        Every figure is read from the confirmed transactions on testnet, never estimated.
      </p>
      {batch ? (
        <BatchReceipt members={batch.members} />
      ) : demoPublic && hashes.length > 0 ? (
        <SingleReceipt account={demoPublic} hashes={hashes} />
      ) : (
        <p className="text-xs text-white/70">No close transaction was recorded for this run.</p>
      )}
      <button
        onClick={() => copy(share())}
        className="mt-3 flex items-center gap-1 text-[11px] text-white/70 hover:text-white"
      >
        {copied ? <Check className="h-3 w-3 text-stellar" /> : <Link2 className="h-3 w-3" />}
        Share this case
      </button>
      <SdkSnippetPanel />
    </section>
  );
}
