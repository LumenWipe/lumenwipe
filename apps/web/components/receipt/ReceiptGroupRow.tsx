"use client";

import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { StepTypeIcon } from "@/lib/utils/stepIcons";
import type { ReceiptGroup } from "@/types/history";

/** One "what was done" group: its title, count and summary, with its details collapsed until
 *  asked for. A native button, so Enter and Space open and close it. */
export default function ReceiptGroupRow({ group }: { group: ReceiptGroup }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const count = group.items.length;

  return (
    <div className="px-4 py-3.5">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full min-w-0 items-start gap-2.5 rounded text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        <StepTypeIcon type={group.type} className="mt-0.5 h-4 w-4 shrink-0 text-accent/70" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-white/85">
            {group.title}
            {count > 0 && <span className="text-fg-muted"> · {count}</span>}
          </span>
          <span className="block text-xs text-fg-muted">{group.summary}</span>
        </span>
        <ChevronDown
          aria-hidden
          className={cn("mt-0.5 h-4 w-4 shrink-0 text-fg-muted", open && "rotate-180")}
        />
      </button>
      <div
        id={id}
        className={cn("mt-2 space-y-1 pl-[1.625rem] text-xs text-fg-muted", !open && "hidden")}
      >
        {count > 0 && (
          <ul className="space-y-1">
            {group.items.map((item, i) => (
              <li key={i} className="break-words">
                <span className={item.mono ? "font-mono-address" : undefined}>{item.text}</span>
                {item.detail && <span> · {item.detail}</span>}
              </li>
            ))}
          </ul>
        )}
        {group.note && <p>{group.note}</p>}
      </div>
    </div>
  );
}
