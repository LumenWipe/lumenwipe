import type { ComponentProps, ReactElement } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils/cn";

export const cardVariants = cva(
  "rounded-card border shadow-[inset_0_1px_0_hsl(var(--edge)/0.08)]",
  {
    variants: {
      tone: {
        neutral: "border-edge/10 bg-surface",
        success: "border-success/20 bg-success/5",
        warning: "border-warning/30 bg-warning/5",
        danger: "border-danger/30 bg-danger/5",
      },
    },
    defaultVariants: { tone: "neutral" },
  }
);

type CardProps = ComponentProps<"div"> & VariantProps<typeof cardVariants>;

export function Card({ tone, className, ...rest }: CardProps): ReactElement {
  return <div {...rest} className={cn(cardVariants({ tone }), className)} />;
}

export function CardHeader({ className, ...rest }: ComponentProps<"div">): ReactElement {
  return <div {...rest} className={cn("border-b border-edge/10 px-4 py-3", className)} />;
}

export function CardTitle({ className, ...rest }: ComponentProps<"h2">): ReactElement {
  return <h2 {...rest} className={cn("mkt-eyebrow text-fg-subtle", className)} />;
}

export function CardBody({ className, ...rest }: ComponentProps<"div">): ReactElement {
  return <div {...rest} className={cn("p-5", className)} />;
}

export function CardFooter({ className, ...rest }: ComponentProps<"div">): ReactElement {
  return <div {...rest} className={cn("border-t border-edge/10 px-4 py-3", className)} />;
}
