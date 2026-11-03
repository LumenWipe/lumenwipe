import { afterEach, expect, mock, test } from "bun:test";
import { useRef, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";

function Content({ extra }: { extra?: boolean }) {
  return (
    <>
      <DialogTitle>Title</DialogTitle>
      <DialogDescription>Description</DialogDescription>
      <button>First</button>
      {extra && <button>Added</button>}
      <button disabled>Disabled</button>
      <button>Last</button>
    </>
  );
}

function Host({ dismissible = true }: { dismissible?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div id="app-root">
        <button onClick={() => setOpen(true)}>Open</button>
      </div>
      {open && (
        <Dialog dismissible={dismissible} onClose={() => setOpen(false)}>
          <Content />
        </Dialog>
      )}
    </>
  );
}

function openHost(dismissible?: boolean): HTMLElement {
  render(<Host dismissible={dismissible} />);
  const trigger = screen.getByRole("button", { name: "Open" });
  trigger.focus();
  fireEvent.click(trigger);
  return trigger;
}

function press(key: string, init: KeyboardEventInit = {}): void {
  fireEvent.keyDown(document.activeElement ?? document.body, { key, ...init });
}

function scrim(): Element {
  return document.querySelector("[data-dialog-scrim]") as Element;
}

afterEach(() => {
  document.documentElement.removeAttribute("style");
});

test("Dialog › names and describes itself as a modal dialog", () => {
  openHost();
  const dialog = screen.getByRole("dialog");
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  const label = document.getElementById(dialog.getAttribute("aria-labelledby") as string);
  const description = document.getElementById(dialog.getAttribute("aria-describedby") as string);
  expect(label?.textContent).toBe("Title");
  expect(description?.textContent).toBe("Description");
});

test("Dialog › a part outside a dialog is refused", () => {
  const error = console.error;
  console.error = () => {};
  expect(() => render(<DialogTitle>Title</DialogTitle>)).toThrow();
  console.error = error;
});

test("Dialog › focus moves to the dialog by default", () => {
  openHost();
  expect(document.activeElement).toBe(screen.getByRole("dialog"));
});

test("Dialog › focus moves to the initial focus target", () => {
  function Targeted() {
    const targetRef = useRef<HTMLButtonElement>(null);
    return (
      <Dialog initialFocusRef={targetRef}>
        <DialogTitle>Title</DialogTitle>
        <DialogDescription>Description</DialogDescription>
        <button>Other</button>
        <button ref={targetRef}>Target</button>
      </Dialog>
    );
  }
  render(<Targeted />);
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Target" }));
});

test("Dialog › Tab from the last control wraps to the first, skipping disabled ones", () => {
  openHost();
  screen.getByRole("button", { name: "Last" }).focus();
  press("Tab");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "First" }));
});

test("Dialog › Shift+Tab from the first control wraps to the last", () => {
  openHost();
  screen.getByRole("button", { name: "First" }).focus();
  press("Tab", { shiftKey: true });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Last" }));
});

function renderWithUntabbableEnds(): void {
  render(
    <Dialog>
      <DialogTitle>Title</DialogTitle>
      <DialogDescription>Description</DialogDescription>
      <button tabIndex={-1}>Skipped start</button>
      <button>First</button>
      <button>Last</button>
      <button tabIndex={-1}>Skipped end</button>
    </Dialog>
  );
}

test("Dialog › Tab from the last tabbable control wraps past a tabindex -1 button", () => {
  renderWithUntabbableEnds();
  screen.getByRole("button", { name: "Last" }).focus();
  press("Tab");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "First" }));
});

test("Dialog › Shift+Tab from the first tabbable control wraps past a tabindex -1 button", () => {
  renderWithUntabbableEnds();
  screen.getByRole("button", { name: "First" }).focus();
  press("Tab", { shiftKey: true });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Last" }));
});

test("Dialog › Tab from the dialog itself enters at either end", () => {
  openHost();
  press("Tab");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "First" }));
  screen.getByRole("dialog").focus();
  press("Tab", { shiftKey: true });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Last" }));
});

test("Dialog › Tab between inner controls is left to the browser", () => {
  openHost();
  screen.getByRole("button", { name: "First" }).focus();
  const allowed = fireEvent.keyDown(document.activeElement as Element, { key: "Tab" });
  expect(allowed).toBe(true);
});

test("Dialog › Tab pulls lost focus back in from the body", () => {
  openHost();
  (document.activeElement as HTMLElement).blur();
  expect(document.activeElement).toBe(document.body);
  fireEvent.keyDown(document.body, { key: "Tab" });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "First" }));
});

test("Dialog › with nothing focusable, Tab keeps focus on the dialog", () => {
  render(
    <Dialog>
      <DialogTitle>Title</DialogTitle>
      <DialogDescription>Description</DialogDescription>
    </Dialog>
  );
  const dialog = screen.getByRole("dialog");
  expect(document.activeElement).toBe(dialog);
  expect(fireEvent.keyDown(dialog, { key: "Tab" })).toBe(false);
  expect(document.activeElement).toBe(dialog);
});

test("Dialog › a control added while open joins the trap", () => {
  const { rerender } = render(
    <Dialog>
      <Content />
    </Dialog>
  );
  screen.getByRole("button", { name: "Last" }).focus();
  rerender(
    <Dialog>
      <Content extra />
      <button>Newest</button>
    </Dialog>
  );
  press("Tab");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Last" }));
  screen.getByRole("button", { name: "Newest" }).focus();
  press("Tab");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "First" }));
  press("Tab", { shiftKey: true });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Newest" }));
});

test("Dialog › a control that becomes disabled while open leaves the trap", () => {
  const view = (disabled: boolean) => (
    <Dialog>
      <DialogTitle>Title</DialogTitle>
      <DialogDescription>Description</DialogDescription>
      <button>One</button>
      <button>Two</button>
      <button disabled={disabled}>Three</button>
    </Dialog>
  );
  const { rerender } = render(view(false));
  screen.getByRole("button", { name: "Two" }).focus();
  rerender(view(true));
  press("Tab");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "One" }));
});

test("Dialog › Escape closes a dismissible dialog", () => {
  openHost();
  press("Escape");
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("Dialog › Escape and the scrim leave a non-dismissible dialog open", () => {
  openHost(false);
  press("Escape");
  fireEvent.click(scrim());
  expect(screen.queryByRole("dialog")).not.toBeNull();
});

test("Dialog › the scrim closes a dismissible dialog", () => {
  openHost();
  fireEvent.click(scrim());
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("Dialog › the current dismissible value decides, not the one at open", () => {
  const onClose = mock(() => {});
  const view = (dismissible: boolean) => (
    <Dialog dismissible={dismissible} onClose={onClose}>
      <Content />
    </Dialog>
  );
  const { rerender } = render(view(true));
  rerender(view(false));
  press("Escape");
  fireEvent.click(scrim());
  expect(onClose).not.toHaveBeenCalled();
  rerender(view(true));
  press("Escape");
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("Dialog › keys pressed in another overlay on the page are left alone", () => {
  const onClose = mock(() => {});
  render(
    <>
      <button>Overlay</button>
      <Dialog onClose={onClose}>
        <Content />
      </Dialog>
    </>
  );
  const overlay = screen.getByRole("button", { name: "Overlay", hidden: true });
  overlay.focus();
  fireEvent.keyDown(overlay, { key: "Escape" });
  expect(fireEvent.keyDown(overlay, { key: "Tab" })).toBe(true);
  expect(onClose).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(overlay);
});

test("Dialog › while suspended it is inert and leaves Tab and Escape alone", () => {
  const onClose = mock(() => {});
  const view = (suspended: boolean) => (
    <Dialog suspended={suspended} onClose={onClose}>
      <Content />
    </Dialog>
  );
  const { rerender } = render(view(true));
  const dialog = document.querySelector("dialog") as HTMLElement;
  expect(dialog.hasAttribute("inert")).toBe(true);

  (document.activeElement as HTMLElement).blur();
  expect(fireEvent.keyDown(document.body, { key: "Tab" })).toBe(true);
  expect(document.activeElement).toBe(document.body);
  fireEvent.keyDown(document.body, { key: "Escape" });
  fireEvent.click(scrim());
  expect(onClose).not.toHaveBeenCalled();

  rerender(view(false));
  expect(dialog.hasAttribute("inert")).toBe(false);
  fireEvent.keyDown(document.body, { key: "Tab" });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "First" }));
  fireEvent.click(scrim());
  expect(onClose).toHaveBeenCalledTimes(1);
});

function TwoDialogs({ open }: { open: { a: boolean; b: boolean } }) {
  return (
    <>
      <div id="app-root" />
      {open.a && (
        <Dialog>
          <Content />
        </Dialog>
      )}
      {open.b && (
        <Dialog>
          <Content />
        </Dialog>
      )}
    </>
  );
}

test("Dialog › background and page stay held until the last dialog closes, first-open out first", () => {
  document.documentElement.style.overflow = "scroll";
  const { rerender } = render(<TwoDialogs open={{ a: true, b: false }} />);
  rerender(<TwoDialogs open={{ a: true, b: true }} />);
  const root = document.getElementById("app-root") as HTMLElement;
  const html = document.documentElement;

  rerender(<TwoDialogs open={{ a: false, b: true }} />);
  expect(root.hasAttribute("inert")).toBe(true);
  expect(html.style.overflow).toBe("hidden");

  rerender(<TwoDialogs open={{ a: false, b: false }} />);
  expect(root.hasAttribute("inert")).toBe(false);
  expect(html.style.overflow).toBe("scroll");
  expect(html.style.scrollbarGutter).toBe("");
});

test("Dialog › background and page stay held until the last dialog closes, last-open out first", () => {
  document.documentElement.style.overflow = "scroll";
  const { rerender } = render(<TwoDialogs open={{ a: true, b: false }} />);
  rerender(<TwoDialogs open={{ a: true, b: true }} />);
  const root = document.getElementById("app-root") as HTMLElement;
  const html = document.documentElement;

  rerender(<TwoDialogs open={{ a: true, b: false }} />);
  expect(root.hasAttribute("inert")).toBe(true);
  expect(html.style.overflow).toBe("hidden");

  rerender(<TwoDialogs open={{ a: false, b: false }} />);
  expect(root.hasAttribute("inert")).toBe(false);
  expect(html.style.overflow).toBe("scroll");
  expect(html.style.scrollbarGutter).toBe("");
});

test("Dialog › focus returns to the trigger after the background is live again", () => {
  const trigger = openHost();
  const root = document.getElementById("app-root") as HTMLElement;
  const originalFocus = trigger.focus.bind(trigger);
  let inertAtFocus: boolean | null = null;
  trigger.focus = (options) => {
    inertAtFocus = root.hasAttribute("inert");
    originalFocus(options);
  };
  press("Escape");
  expect(inertAtFocus === false).toBe(true);
  expect(document.activeElement).toBe(trigger);
});

test("Dialog › closing after the trigger is gone does not throw", () => {
  const trigger = openHost();
  trigger.remove();
  expect(() => press("Escape")).not.toThrow();
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("Dialog › the background is inert and the page locked only while open", () => {
  openHost();
  const root = document.getElementById("app-root") as HTMLElement;
  const html = document.documentElement;
  expect(root.hasAttribute("inert")).toBe(true);
  expect(html.style.overflow).toBe("hidden");
  press("Escape");
  expect(root.hasAttribute("inert")).toBe(false);
  expect(html.style.overflow).toBe("");
});

test("Dialog › renders outside the inert background", () => {
  openHost();
  const root = document.getElementById("app-root") as HTMLElement;
  expect(root.contains(screen.getByRole("dialog"))).toBe(false);
});

test("Dialog › the right side variant fills the height and hugs the edge", () => {
  render(
    <Dialog side="right">
      <Content />
    </Dialog>
  );
  const dialog = screen.getByRole("dialog");
  expect(dialog.className).toContain("h-full");
  expect(dialog.parentElement?.className).toContain("justify-end");
});

test("Dialog › the body scrolls inside and keeps the global focus ring", () => {
  render(
    <Dialog>
      <Content />
      <DialogBody data-testid="body" />
      <DialogFooter data-testid="footer" />
    </Dialog>
  );
  const body = screen.getByTestId("body");
  expect(body.className).toContain("overflow-y-auto");
  expect(body.className).not.toContain("outline-none");
  expect(body.tabIndex).toBe(0);
  expect(screen.getByTestId("footer").className).toContain("sm:flex-row");
});

test("Dialog › the dialog stops existing with its host", () => {
  const { unmount } = render(
    <Dialog>
      <Content />
    </Dialog>
  );
  unmount();
  expect(document.querySelector("dialog")).toBeNull();
});
