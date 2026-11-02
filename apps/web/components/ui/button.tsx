"use client";

import {
  Children,
  cloneElement,
  useLayoutEffect,
  useRef,
  type ComponentProps,
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
  ],
  {
    variants: {
      variant: {
        primary:
          "bg-accent text-accent-fg not-disabled:hover:bg-accent/90 not-disabled:active:bg-accent/80",
        secondary:
          "border border-line-strong text-fg not-disabled:hover:bg-surface-raised not-disabled:active:bg-surface",
        ghost: "text-fg-muted not-disabled:hover:bg-surface-raised not-disabled:hover:text-fg",
        danger:
          "bg-danger text-danger-on-fill not-disabled:hover:bg-danger/90 not-disabled:active:bg-danger/80",
        warning:
          "bg-warning text-warning-fg not-disabled:hover:bg-warning/90 not-disabled:active:bg-warning/80",
      },
      size: {
        sm: "min-h-control px-3 text-xs md:min-h-9",
        md: "min-h-control px-4 text-sm md:min-h-9",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  }
);

type ButtonStyle = VariantProps<typeof buttonVariants> & { className?: string };

type NativeButtonProps = ButtonStyle &
  Omit<ComponentProps<"button">, "ref" | "className"> & {
    ref?: Ref<HTMLButtonElement>;
    asChild?: false;
    loading?: boolean;
    /** Replaced by the spinner while loading. */
    icon?: ReactNode;
    iconEnd?: ReactNode;
  };

/** Styles a link child instead of rendering a button. A link has no inert state: `href` still
 *  opens on middle click and from a screen reader, so the props that imply one are refused. */
type SlotButtonProps = ButtonStyle & {
  asChild: true;
  ref?: Ref<HTMLElement>;
  children: ReactElement<{ className?: string; ref?: Ref<HTMLElement> }>;
  disabled?: never;
  loading?: never;
  icon?: never;
  iconEnd?: never;
};

type ButtonProps = NativeButtonProps | SlotButtonProps;

function assignRef<T>(ref: Ref<T> | undefined, node: T | null): void {
  if (typeof ref === "function") ref(node);
  else if (ref) ref.current = node;
}

function NativeButton({
  variant,
  size,
  className,
  ref,
  loading = false,
  disabled = false,
  icon,
  iconEnd,
  asChild: _asChild,
  children,
  ...rest
}: NativeButtonProps): ReactElement {
  const node = useRef<HTMLButtonElement | null>(null);
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
  }, [loading]);

  return (
    <button
      {...rest}
      ref={(el) => {
        node.current = el;
        assignRef(ref, el);
      }}
      disabled={disabled || loading}
      aria-busy={loading ? true : undefined}
      className={cn(buttonVariants({ variant, size }), className)}
    >
      {loading ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : icon}
      {children}
      {!loading && iconEnd}
    </button>
  );
}

function slotProps(
  { variant, size, className, ref }: SlotButtonProps,
  child: SlotButtonProps["children"]
): { className: string; ref: (el: HTMLElement | null) => void } {
  return {
    className: cn(buttonVariants({ variant, size }), className, child.props.className),
    ref: (el) => {
      assignRef(child.props.ref, el);
      assignRef(ref, el);
    },
  };
}

export function Button(props: ButtonProps): ReactElement {
  if (!props.asChild) return <NativeButton {...props} />;
  const child = Children.only(props.children);
  return cloneElement(child, slotProps(props, child));
}
