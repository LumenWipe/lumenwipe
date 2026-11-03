import type { ComponentProps, ReactElement, ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils/cn";

export const calloutVariants = cva("flex items-start gap-2.5 rounded-card border p-3.5 text-sm", {
  variants: {
    tone: {
      info: "border-accent/30 bg-accent/10",
      success: "border-success/30 bg-success/10",
      warning: "border-warning/30 bg-warning/10",
      danger: "border-danger/30 bg-danger/10",
    },
  },
  defaultVariants: { tone: "info" },
});

type Tone = NonNullable<VariantProps<typeof calloutVariants>["tone"]>;

const TONE_TEXT: Record<Tone, string> = {
  info: "text-accent",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger-fg",
};

const TONE_ROLE: Record<Tone, "alert" | "status" | undefined> = {
  info: undefined,
  success: "status",
  warning: "alert",
  danger: "alert",
};

interface CalloutProps extends Omit<ComponentProps<"div">, "title" | "role"> {
  tone?: Tone;
  icon?: ReactNode;
  title?: ReactNode;
  action?: ReactNode;
  /** Live-region role. Pass false for a box already on screen when the page loads. */
  announce?: "alert" | "status" | false;
}

export function Callout({
  tone = "info",
  icon,
  title,
  action,
  announce,
  className,
  children,
  ...rest
}: CalloutProps): ReactElement {
  const role = announce === undefined ? TONE_ROLE[tone] : announce || undefined;
  return (
    <div {...rest} role={role} className={cn(calloutVariants({ tone }), className)}>
      {icon && <span className={cn("mt-0.5 shrink-0", TONE_TEXT[tone])}>{icon}</span>}
      <div className="min-w-0 flex-1">
        {title && <div className={cn("mb-1 font-semibold", TONE_TEXT[tone])}>{title}</div>}
        <div className={title || tone === "info" ? "text-fg-muted" : TONE_TEXT[tone]}>
          {children}
        </div>
        {action && <div className="mt-3">{action}</div>}
      </div>
    </div>
  );
}
