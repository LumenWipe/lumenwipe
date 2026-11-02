import type { ComponentProps, ReactElement } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils/cn";

export const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-badge border px-1.5 py-0.5 text-xs font-medium",
  {
    variants: {
      tone: {
        neutral: "border-line-strong bg-surface-raised text-fg-muted",
        accent: "border-accent/30 bg-accent/10 text-accent",
        value: "border-value/30 bg-value/10 text-value",
        success: "border-success/30 bg-success/10 text-success",
        warning: "border-warning/30 bg-warning/20 text-warning",
        danger: "border-danger/40 bg-danger/10 text-danger-fg",
      },
    },
    defaultVariants: { tone: "neutral" },
  }
);

type BadgeProps = ComponentProps<"span"> & VariantProps<typeof badgeVariants>;

export function Badge({ tone, className, ...rest }: BadgeProps): ReactElement {
  return <span {...rest} className={cn(badgeVariants({ tone }), className)} />;
}
