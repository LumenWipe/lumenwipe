"use client";

import { willCreate, type MessStepDef } from "@/lib/scenarios";
import Disclosure from "./Disclosure";

/** What the run is about to create on testnet, before anything is created. Folded by default:
 *  the label says how much, and opening it lists each kind of thing. */
export default function WillCreateList({ steps }: { steps: readonly MessStepDef[] }) {
  const lines = willCreate(steps);
  return (
    <Disclosure
      label={<span id="will-create-heading">This will create on testnet</span>}
      hint={`${lines.length} ${lines.length === 1 ? "item" : "items"}`}
      className="mt-3"
    >
      <section aria-labelledby="will-create-heading" className="text-xs text-white/75">
        <ul className="list-disc space-y-0.5 pl-4">
          {lines.map((line, i) => (
            <li key={`${i}-${line}`}>{line}</li>
          ))}
        </ul>
        <p className="mt-2 text-subtle">
          The demo account lives for one hour, with one 30-minute extension, and holds test XLM
          only.
        </p>
      </section>
    </Disclosure>
  );
}
