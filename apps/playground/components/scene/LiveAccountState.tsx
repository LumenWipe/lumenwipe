"use client";

import type { AccountState } from "@lumenwipe/sdk";
import { lockedReserveXlm } from "@/lib/account-summary";

/** The demo account as the LumenWipe API last read it, refreshed after every setup step. */
export default function LiveAccountState({ state }: { state: AccountState }) {
  const { low, med, high } = state.thresholds;
  return (
    <section
      aria-label="Demo account right now"
      className="mt-3 rounded-md border border-white/10 bg-white/[0.03] px-4 py-3"
    >
      <p className="mkt-eyebrow mb-2 text-[0.6rem] text-subtle">Demo account right now</p>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
        <dt className="text-subtle">Sub-entries</dt>
        <dd className="mkt-mono text-white/85">{state.numSubEntries}</dd>
        <dt className="text-subtle">Locked reserve</dt>
        <dd className="mkt-mono text-white/85">{lockedReserveXlm(state).toFixed(1)} XLM</dd>
        <dt className="text-subtle">Signers</dt>
        <dd className="mkt-mono text-white/85">{state.signers.length}</dd>
        <dt className="text-subtle">Thresholds</dt>
        <dd className="mkt-mono text-white/85">
          low {low}, medium {med}, high {high}
        </dd>
      </dl>
    </section>
  );
}
