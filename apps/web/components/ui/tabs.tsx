"use client";

import { useId, type KeyboardEvent, type ReactElement, type ReactNode } from "react";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils/cn";

const listVariants = cva("flex gap-2 rounded-lg p-1", {
  variants: {
    size: {
      md: "bg-white/[0.03]",
      sm: "border border-white/10 bg-black/20 text-xs",
    },
  },
});

const tabVariants = cva(
  "flex flex-1 items-center justify-center gap-1.5 rounded-md transition-colors",
  {
    variants: {
      size: {
        md: "py-2 text-sm font-medium",
        sm: "py-1.5",
      },
      selected: {
        true: "bg-white/10 text-white",
        false: "text-fg-muted hover:text-white/80",
      },
    },
  }
);

export interface TabItem<V extends string> {
  value: V;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

interface TabsProps<V extends string> {
  /** Names the tablist for assistive technology. */
  label: string;
  items: readonly TabItem<V>[];
  value: V;
  /** Fires on every click, the selected tab included, and on arrow, Home and End moves. */
  onValueChange: (value: V) => void;
  size?: "md" | "sm";
  /** The selected tab's panel. */
  children: ReactNode;
}

/** Selection follows focus. The caller owns the value and renders what the selected tab shows. */
export function Tabs<V extends string>({
  label,
  items,
  value,
  onValueChange,
  size = "md",
  children,
}: TabsProps<V>): ReactElement {
  const baseId = useId();
  const panelId = `${baseId}-panel`;
  const tabId = (item: V): string => `${baseId}-tab-${item}`;

  const enabled = items.filter((item) => !item.disabled);
  const tabStop = enabled.find((item) => item.value === value) ?? enabled[0];

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, from: V): void {
    if (event.altKey || event.ctrlKey || event.metaKey) return;

    const position = enabled.findIndex((item) => item.value === from);
    const last = enabled.length - 1;
    const targets: Record<string, number> = {
      ArrowRight: position === last ? 0 : position + 1,
      ArrowLeft: position === 0 ? last : position - 1,
      Home: 0,
      End: last,
    };
    const target = enabled[targets[event.key]];
    if (!target) return;

    event.preventDefault();
    document.getElementById(tabId(target.value))?.focus();
    onValueChange(target.value);
  }

  return (
    <>
      <div role="tablist" aria-label={label} className={listVariants({ size })}>
        {items.map((item) => {
          const selected = item.value === value;
          return (
            <button
              key={item.value}
              id={tabId(item.value)}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={panelId}
              tabIndex={item === tabStop ? 0 : -1}
              disabled={item.disabled}
              onClick={() => onValueChange(item.value)}
              onKeyDown={(event) => handleKeyDown(event, item.value)}
              className={cn(tabVariants({ size, selected }))}
            >
              {item.icon}
              {item.label}
            </button>
          );
        })}
      </div>
      <div id={panelId} role="tabpanel" aria-labelledby={tabId(value)}>
        {children}
      </div>
    </>
  );
}
