"use client";

import { willCreate, type MessStepDef } from "@/lib/scenarios";

/** What the run is about to create on testnet, before anything is created. */
export default function WillCreateList({ steps }: { steps: readonly MessStepDef[] }) {
  return (
    <section
      aria-labelledby="will-create-heading"
      className="mt-4 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2.5 text-xs text-white/75"
    >
      <p id="will-create-heading" className="mkt-eyebrow mb-1.5 text-[0.6rem] text-subtle">
        This will create on testnet
      </p>
      <ul className="list-disc space-y-0.5 pl-4">
        {willCreate(steps).map((line, i) => (
          <li key={`${i}-${line}`}>{line}</li>
        ))}
      </ul>
      <p className="mt-2 text-subtle">
        The demo account lives for one hour, with one 30-minute extension, and holds test XLM only.
      </p>
    </section>
  );
}
