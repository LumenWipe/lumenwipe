"use client";

import { Check, CircleDashed, Loader2, ShieldAlert, XCircle } from "lucide-react";
import { usePlaygroundStore, type BatchMember, type BatchSize } from "@/store/playground";
import { blockerCopy, GENERIC_ERROR_COPY } from "@/lib/error-copy";
import BlockerCard from "./BlockerCard";

const PLAN_COPY: Record<Exclude<BatchMember["plan"], "unavailable" | null>["status"], string> = {
  ready: "Ready to close",
  needs_decisions: "Ready once the playground answers its questions",
  blocked: "Blocked",
  complete: "Already closed",
};

const CLOSE_COPY: Record<BatchMember["close"], string> = {
  waiting: "Waiting",
  closing: "Closing...",
  closed: "Merged into the market maker",
  blocked: "Not closed: blocked",
  failed: "Not closed",
};

function CloseIcon({ close }: { close: BatchMember["close"] }) {
  if (close === "closed") return <Check className="h-3.5 w-3.5 text-stellar" aria-hidden />;
  if (close === "closing") {
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-stellar" aria-hidden />;
  }
  if (close === "blocked") return <ShieldAlert className="h-3.5 w-3.5 text-value" aria-hidden />;
  if (close === "failed") return <XCircle className="h-3.5 w-3.5 text-destructive" aria-hidden />;
  return <CircleDashed className="h-3.5 w-3.5 text-subtle" aria-hidden />;
}

function MemberRow({
  member,
  index,
  expectedBlocked,
  onResolve,
}: {
  member: BatchMember;
  index: number;
  expectedBlocked: boolean;
  onResolve: (index: number, blocker: string) => void;
}) {
  const n = index + 1;
  return (
    <li
      aria-label={`Account ${n}`}
      className="rounded-md border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white/75"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium text-white/85">
          Account {n}
          {expectedBlocked && (
            <span className="ml-2 text-xs font-normal text-value">blocked on purpose</span>
          )}
        </p>
        <span title={member.demoPublic} className="mkt-mono text-[11px] text-white/60">
          {member.demoPublic.slice(0, 6)}…{member.demoPublic.slice(-6)}
        </span>
      </div>
      <p className="mt-1 text-xs text-white/55">{member.label}</p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-subtle">Setup</dt>
        <dd>
          {member.messDone} of {member.messPlan.length} steps
        </dd>
        <dt className="text-subtle">Batch plan</dt>
        <dd>
          {member.plan === "unavailable"
            ? "Could not be read"
            : member.plan
              ? PLAN_COPY[member.plan.status]
              : "Not planned yet"}
          {member.plan && member.plan !== "unavailable" && member.plan.blockers.length > 0 && (
            <ul aria-label={`Account ${n} blockers`} className="mt-1 space-y-1 text-white/60">
              {member.plan.blockers.map((b) => (
                <li key={b.code}>{blockerCopy(b.code)}</li>
              ))}
            </ul>
          )}
        </dd>
        <dt className="text-subtle">Close</dt>
        <dd className="flex items-center gap-1.5">
          <CloseIcon close={member.close} />
          <span>{CLOSE_COPY[member.close]}</span>
          {member.hashes.length > 0 && (
            <span className="text-subtle">
              ({member.hashes.length} transaction{member.hashes.length === 1 ? "" : "s"})
            </span>
          )}
        </dd>
      </dl>
      {member.close === "blocked" && member.stop && (
        <div className="mt-3">
          <BlockerCard
            message={member.message ?? GENERIC_ERROR_COPY}
            stop={member.stop}
            onResolve={(blocker) => onResolve(index, blocker)}
          />
        </div>
      )}
      {member.close === "failed" && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {member.message ?? GENERIC_ERROR_COPY}
        </p>
      )}
    </li>
  );
}

/** Every member of the batch, with the API's plan for it and how its close went. */
export default function BatchPanel({
  onResolve,
}: {
  onResolve: (index: number, blocker: string) => void;
}) {
  const batch = usePlaygroundStore((s) => s.batch);
  if (!batch) return null;
  return (
    <div>
      <p className="mkt-eyebrow mb-1 text-white/50">Batch close</p>
      <p className="mb-4 text-sm text-white/65">
        {batch.members.length} demo accounts, planned with one call to the LumenWipe API, then
        closed one after another. One is blocked on purpose: it is reported, not skipped.
      </p>
      {batch.members.some((m) => m.plan === "unavailable") && (
        <p className="mb-4 text-sm text-white/65">
          The batch plan could not be read, but every account can still be closed.
        </p>
      )}
      <ol aria-label="Batch accounts" className="space-y-3">
        {batch.members.map((member, index) => (
          <MemberRow
            key={member.sessionId}
            member={member}
            index={index}
            expectedBlocked={index === batch.blockedIndex}
            onResolve={onResolve}
          />
        ))}
      </ol>
    </div>
  );
}

const SIZES: readonly { value: BatchSize; label: string }[] = [
  { value: 0, label: "One account" },
  { value: 2, label: "A batch of 2" },
  { value: 3, label: "A batch of 3" },
];

/** Picks one account or a batch, before a run starts. */
export function BatchSizeField() {
  const batchSize = usePlaygroundStore((s) => s.batchSize);
  const setBatchSize = usePlaygroundStore((s) => s.setBatchSize);
  return (
    <fieldset className="mb-4">
      <legend className="mkt-eyebrow mb-2 text-[0.6rem] text-white/50">Accounts to close</legend>
      <div className="flex flex-wrap gap-2">
        {SIZES.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            aria-pressed={batchSize === value}
            onClick={() => setBatchSize(value)}
            className={`rounded-md border px-3 py-1.5 text-xs transition-colors ${
              batchSize === value
                ? "border-stellar/60 bg-[hsl(var(--stellar)/0.12)] text-white"
                : "border-white/15 text-white/65 hover:bg-white/5"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {batchSize > 0 && (
        <p className="mt-2 text-xs leading-relaxed text-white/55">
          {batchSize - 1} account{batchSize === 2 ? "" : "s"} with a small classic mess, plus one
          holding a claimable balance it created, which the API reports blocked.
        </p>
      )}
    </fieldset>
  );
}
