"use client";

import {
  Children,
  cloneElement,
  isValidElement,
  useLayoutEffect,
  useRef,
  type ComponentProps,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils/cn";

export const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 rounded-control font-semibold",
    "transition-colors duration-fast ease-standard",
    "disabled:cursor-not-allowed disabled:opacity-40",
    "aria-disabled:pointer-events-none aria-disabled:opacity-40",
  ],
  {
    variants: {
      variant: {
        primary: "bg-accent text-accent-fg not-disabled:hover:bg-accent/90 active:bg-accent/80",
        secondary:
          "border border-line-strong text-fg not-disabled:hover:bg-surface-raised active:bg-surface",
        ghost: "text-fg-muted not-disabled:hover:bg-surface-raised not-disabled:hover:text-fg",
        danger: "bg-danger text-danger-on-fill not-disabled:hover:bg-danger/90 active:bg-danger/80",
        warning: "bg-warning text-warning-fg not-disabled:hover:bg-warning/90 active:bg-warning/80",
      },
      size: {
        sm: "min-h-control px-3 text-xs md:min-h-9",
        md: "min-h-control px-4 text-sm md:min-h-9",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  }
);

type SlotChildProps = {
  className?: string;
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  ref?: Ref<HTMLElement>;
};

interface ButtonProps
  extends Omit<ComponentProps<"button">, "ref">, VariantProps<typeof buttonVariants> {
  ref?: Ref<HTMLButtonElement>;
  loading?: boolean;
  /** Replaced by the spinner while loading. */
  icon?: ReactNode;
  iconEnd?: ReactNode;
  /** Styles the single child element, for links, instead of rendering a button. */
  asChild?: boolean;
}

function assignRef<T>(ref: Ref<T> | undefined, node: T | null): void {
  if (typeof ref === "function") ref(node);
  else if (ref) ref.current = node;
}

function blockActivation(event: MouseEvent<HTMLElement>): void {
  event.preventDefault();
  event.stopPropagation();
}

export function Button({
  variant,
  size,
  className,
  ref,
  loading = false,
  disabled = false,
  icon,
  iconEnd,
  asChild = false,
  onClick,
  children,
  ...rest
}: ButtonProps): ReactElement {
  const node = useRef<HTMLElement | null>(null);
  const restingWidth = useRef(0);

  useLayoutEffect(() => {
    const el = node.current;
    if (!el) return;
    if (loading) {
      if (restingWidth.current > 0) el.style.minWidth = `${restingWidth.current}px`;
    } else {
      el.style.minWidth = "";
      restingWidth.current = el.offsetWidth;
    }
  });

  const classes = buttonVariants({ variant, size });
  const busy = loading ? true : undefined;
  const inert = disabled || loading;

  if (asChild) {
    const child = Children.only(children);
    if (!isValidElement<SlotChildProps>(child)) throw new Error("asChild needs one element child");
    const childOnClick = child.props.onClick;
    const childRef = child.props.ref;
    const buttonOnClick = onClick as ((event: MouseEvent<HTMLElement>) => void) | undefined;
    const slotProps: Record<string, unknown> = {
      ...rest,
      "aria-busy": busy,
      className: cn(classes, className, child.props.className),
      ref: (el: HTMLElement | null) => {
        node.current = el;
        assignRef(childRef, el);
        assignRef(ref as Ref<HTMLElement> | undefined, el);
      },
      ...(inert
        ? { "aria-disabled": true, tabIndex: -1, onClick: blockActivation }
        : {
            onClick: (event: MouseEvent<HTMLElement>) => {
              childOnClick?.(event);
              buttonOnClick?.(event);
            },
          }),
    };
    return cloneElement(child, slotProps);
  }

  return (
    <button
      {...rest}
      ref={(el) => {
        node.current = el;
        assignRef(ref, el);
      }}
      onClick={onClick}
      disabled={inert}
      aria-busy={busy}
      className={cn(classes, className)}
    >
      {loading ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : icon}
      {children}
      {!loading && iconEnd}
    </button>
  );
}
