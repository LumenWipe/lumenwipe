"use client";

import {
  createContext,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils/cn";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

interface DialogIds {
  titleId: string;
  descriptionId: string;
}

const DialogContext = createContext<DialogIds | null>(null);

function useDialogIds(): DialogIds {
  const ids = useContext(DialogContext);
  if (!ids) throw new Error("Dialog parts must be rendered inside a Dialog.");
  return ids;
}

function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.closest("[hidden],[inert]")
  );
}

function containTab(event: KeyboardEvent, dialog: HTMLElement): void {
  const items = focusableIn(dialog);
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  const outside = active === dialog || !dialog.contains(active);

  let next: HTMLElement | undefined;
  if (!first || !last) next = dialog;
  else if (outside) next = event.shiftKey ? last : first;
  else if (event.shiftKey && active === first) next = last;
  else if (!event.shiftKey && active === last) next = first;

  if (next) {
    event.preventDefault();
    next.focus();
  }
}

interface DialogProps {
  children: ReactNode;
  onClose?: () => void;
  /** When false, Escape and the scrim do nothing. */
  dismissible?: boolean;
  /** Receives focus on open. Defaults to the dialog itself. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  side?: "center" | "right";
  className?: string;
}

/**
 * A modal that is open for as long as it is mounted, so whatever a caller holds inside it ends
 * with the unmount. It stays out of the top layer on purpose: `showModal()` would cover and inert
 * the wallet kit's connect overlay, which is appended to `body` above this one, and its close
 * request can outlast a prevented `cancel`.
 */
export function Dialog({
  children,
  onClose,
  dismissible = true,
  initialFocusRef,
  side = "center",
  className,
}: DialogProps): ReactElement {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const ids = useMemo(() => ({ titleId, descriptionId }), [titleId, descriptionId]);

  useLayoutEffect(() => {
    const background = document.getElementById("app-root");
    const root = document.documentElement;
    const trigger = document.activeElement as HTMLElement | null;
    const { overflow, scrollbarGutter } = root.style;

    background?.setAttribute("inert", "");
    root.style.overflow = "hidden";
    root.style.scrollbarGutter = "stable";
    (initialFocusRef?.current ?? dialogRef.current)?.focus({ preventScroll: true });

    return () => {
      root.style.overflow = overflow;
      root.style.scrollbarGutter = scrollbarGutter;
      // An inert element refuses focus, so the background has to come back first.
      background?.removeAttribute("inert");
      trigger?.focus({ preventScroll: true });
    };
    // Only the opening focus target is read: a later ref change must not re-run the open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const dialog = dialogRef.current;
      const target = event.target as Node;
      if (!dialog || (target !== document.body && !dialog.contains(target))) return;
      if (event.key === "Tab") containTab(event, dialog);
      else if (event.key === "Escape" && dismissible) onClose?.();
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [dismissible, onClose]);

  return createPortal(
    <div
      className={cn(
        "fixed inset-0 z-[100] flex items-center",
        side === "right" ? "justify-end" : "justify-center p-4"
      )}
    >
      <div
        aria-hidden
        data-dialog-scrim
        className={cn(
          "absolute inset-0 backdrop-blur-xs",
          side === "right" ? "bg-black/40" : "bg-black/70"
        )}
        onClick={dismissible ? onClose : undefined}
      />
      <dialog
        ref={dialogRef}
        open
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        className={cn(
          "relative m-0 flex w-full flex-col bg-surface p-0 text-fg shadow-2xl",
          side === "right"
            ? "h-full max-h-none max-w-sm border-l border-white/10"
            : "max-h-full max-w-md rounded-2xl border border-white/15",
          className
        )}
      >
        <DialogContext.Provider value={ids}>{children}</DialogContext.Provider>
      </dialog>
    </div>,
    document.body
  );
}

export function DialogTitle({ className, ...rest }: ComponentProps<"h2">): ReactElement {
  const { titleId } = useDialogIds();
  return <h2 {...rest} id={titleId} className={className} />;
}

export function DialogDescription({ className, ...rest }: ComponentProps<"p">): ReactElement {
  const { descriptionId } = useDialogIds();
  return <p {...rest} id={descriptionId} className={className} />;
}

/** Focusable so a keyboard can scroll it; the ring is inset because the header and footer abut it. */
export function DialogBody({ className, ...rest }: ComponentProps<"div">): ReactElement {
  return (
    <div
      {...rest}
      tabIndex={0}
      className={cn("min-h-0 flex-1 overflow-y-auto -outline-offset-2", className)}
    />
  );
}

export function DialogFooter({ className, ...rest }: ComponentProps<"div">): ReactElement {
  return <div {...rest} className={cn("flex flex-col gap-2 sm:flex-row", className)} />;
}
