"use client";

import { useId, type ReactElement, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { Card } from "@/components/ui/card";

type CardTone = "neutral" | "success" | "warning";

export interface DecisionOption<V extends string> {
  value: V;
  /** The outcome sentence. */
  label: ReactNode;
  tag?: { label: string; tone: "success" | "neutral" | "warning" };
  detail?: ReactNode;
  /** Shown in the warning color while this option is selected. */
  notice?: ReactNode;
  /** Shown under the option while it is selected, outside its label. */
  children?: ReactNode;
}

export const DECISION_TAGS = {
  recommended: { label: "Recommended", tone: "success" },
  keep: { label: "You keep the tokens", tone: "neutral" },
  giveUp: { label: "You give up the tokens", tone: "warning" },
  keepBalance: { label: "You keep the balance", tone: "neutral" },
  giveUpBalance: { label: "You give up the balance", tone: "warning" },
} as const satisfies Record<string, NonNullable<DecisionOption<string>["tag"]>>;

interface DecisionCardProps<V extends string> {
  /** Names the radio group for assistive technology. */
  legend: string;
  options: readonly DecisionOption<V>[];
  value: V | undefined;
  onValueChange: (value: V) => void;
  tone: CardTone;
  /** The card's summary above the options. */
  children: ReactNode;
  "data-testid"?: string;
}

export function DecisionCard<V extends string>({
  legend,
  options,
  value,
  onValueChange,
  tone,
  children,
  "data-testid": testId,
}: DecisionCardProps<V>): ReactElement {
  const name = useId();
  return (
    <Card tone={tone} className="p-3 transition-colors" data-testid={testId}>
      {children}
      <fieldset className="mt-3 space-y-1.5">
        <legend className="sr-only">{legend}</legend>
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <div key={option.value}>
              <label
                className={cn(
                  "flex min-h-11 cursor-pointer items-start gap-2.5 rounded-md border px-2.5 py-2 text-xs transition-colors",
                  selected
                    ? "border-accent/60 bg-accent/10 text-white"
                    : "border-white/10 text-white/70 hover:border-white/20"
                )}
              >
                <input
                  type="radio"
                  name={name}
                  value={option.value}
                  checked={selected}
                  onChange={() => onValueChange(option.value)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
                />
                <span className="min-w-0 flex-1">
                  <span className="block">{option.label}</span>
                  {option.detail && (
                    <span className="mt-0.5 block text-fg-subtle">{option.detail}</span>
                  )}
                </span>
                {option.tag && (
                  <Badge tone={option.tag.tone} className="shrink-0">
                    {option.tag.label}
                  </Badge>
                )}
              </label>
              {selected && option.notice && (
                <Callout
                  tone="warning"
                  announce="status"
                  icon={<AlertTriangle className="h-4 w-4" />}
                  className="mt-1.5"
                >
                  {option.notice}
                </Callout>
              )}
              {selected && option.children && <div className="mt-1.5 pl-1">{option.children}</div>}
            </div>
          );
        })}
      </fieldset>
    </Card>
  );
}
