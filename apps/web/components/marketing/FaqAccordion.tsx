"use client";

import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";

export type FaqItem = { q: string; a: React.ReactNode };

export default function FaqAccordion({ items }: { items: readonly FaqItem[] }) {
  const [open, setOpen] = useState<number | null>(0);
  const baseId = useId();

  return (
    <div className="divide-y divide-white/8 overflow-hidden rounded-2xl border border-white/10 bg-surface/60">
      {items.map((item, i) => {
        const isOpen = open === i;
        return (
          <div key={item.q}>
            <button
              type="button"
              id={`${baseId}-${i}-header`}
              aria-controls={`${baseId}-${i}-panel`}
              onClick={() => setOpen(isOpen ? null : i)}
              aria-expanded={isOpen}
              className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition-colors hover:bg-white/[0.02] focus-visible:-outline-offset-2 sm:px-6 sm:py-5"
            >
              <span
                className={`text-body font-medium transition-colors ${
                  isOpen ? "text-white" : "text-white/80"
                }`}
              >
                {item.q}
              </span>
              <ChevronDown
                className={`h-4 w-4 shrink-0 text-accent transition-transform duration-300 ${
                  isOpen ? "rotate-180" : ""
                }`}
              />
            </button>
            <div
              id={`${baseId}-${i}-panel`}
              role="region"
              aria-labelledby={`${baseId}-${i}-header`}
              inert={!isOpen}
              className={`grid transition-all duration-300 ease-out ${
                isOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
              }`}
            >
              <div className="overflow-hidden">
                <p className="px-5 pb-5 pr-10 text-sm leading-relaxed text-white/85 sm:px-6 sm:pb-6">
                  {item.a}
                </p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
