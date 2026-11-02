import { expect, test } from "bun:test";
import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

test.each([
  ["primary", ["bg-accent", "text-accent-fg"]],
  ["secondary", ["border-line-strong", "text-fg"]],
  ["ghost", ["text-fg-muted"]],
  ["danger", ["bg-danger", "text-danger-on-fill"]],
  ["warning", ["bg-warning", "text-warning-fg"]],
] as const)("the %s variant renders its token classes", (variant, classes) => {
  render(<Button variant={variant}>Go</Button>);
  const list = screen.getByRole("button", { name: "Go" }).className.split(" ");
  for (const c of classes) expect(list).toContain(c);
});

test("no variant carries a raw palette or a glow", () => {
  for (const variant of ["primary", "secondary", "ghost", "danger", "warning"] as const) {
    const { unmount } = render(<Button variant={variant}>Go</Button>);
    const cls = screen.getByRole("button").className;
    expect(cls).not.toMatch(/stellar|text-black|shadow-\[|(amber|red|emerald)-\d/);
    unmount();
  }
});

test.each(["sm", "md"] as const)("the %s size is 44px below md and 36px from md", (size) => {
  render(<Button size={size}>Go</Button>);
  const list = screen.getByRole("button").className.split(" ");
  expect(list).toContain("min-h-control");
  expect(list).toContain("md:min-h-9");
});

test("disabled blocks the click and leaves aria-busy unset", () => {
  let clicks = 0;
  render(
    <Button disabled onClick={() => clicks++}>
      Go
    </Button>
  );
  const button = screen.getByRole("button") as HTMLButtonElement;
  fireEvent.click(button);
  expect(button.disabled).toBe(true);
  expect(button.hasAttribute("aria-busy")).toBe(false);
  expect(clicks).toBe(0);
});

test("loading disables, sets aria-busy, swaps the icon for a spinner and keeps the label", () => {
  const icon = <svg data-testid="icon" />;
  const end = <svg data-testid="end" />;
  const { rerender } = render(
    <Button icon={icon} iconEnd={end}>
      Go
    </Button>
  );
  expect(screen.getByTestId("icon")).toBeTruthy();
  expect(screen.getByTestId("end")).toBeTruthy();

  rerender(
    <Button loading icon={icon} iconEnd={end}>
      Go
    </Button>
  );
  const button = screen.getByRole("button") as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(button.getAttribute("aria-busy")).toBe("true");
  expect(button.textContent).toBe("Go");
  expect(screen.queryByTestId("icon")).toBeNull();
  expect(screen.queryByTestId("end")).toBeNull();
  expect(button.querySelector("svg.animate-spin")).not.toBeNull();
});

test("loading locks the width measured at rest and releases it afterwards", () => {
  const { rerender } = render(<Button>Go</Button>);
  const button = screen.getByRole("button");
  Object.defineProperty(button, "offsetWidth", { configurable: true, value: 123 });
  rerender(<Button>Go</Button>);

  Object.defineProperty(button, "offsetWidth", { configurable: true, value: 150 });
  rerender(<Button loading>Go</Button>);
  expect(button.style.minWidth).toBe("123px");

  rerender(<Button>Go</Button>);
  expect(button.style.minWidth).toBe("");
});

test("the ref reaches the button", () => {
  const ref = createRef<HTMLButtonElement>();
  render(<Button ref={ref}>Go</Button>);
  expect(ref.current).toBe(screen.getByRole("button") as HTMLButtonElement);
});

test("the type is left to the caller", () => {
  render(<Button>Go</Button>);
  expect(screen.getByRole("button").hasAttribute("type")).toBe(false);
});

test("asChild renders the child element, not a button, and merges className", () => {
  render(
    <Button asChild variant="secondary" className="mt-4">
      <Link href="/testnet" className="child-class">
        Home
      </Link>
    </Button>
  );
  const link = screen.getByRole("link", { name: "Home" });
  expect(screen.queryByRole("button")).toBeNull();
  expect(link.tagName).toBe("A");
  expect(link.getAttribute("href")).toBe("/testnet");
  const list = link.className.split(" ");
  for (const c of ["border-line-strong", "mt-4", "child-class"]) expect(list).toContain(c);
});

test("asChild forwards the ref to the child and keeps the child's own ref", () => {
  const outer = createRef<HTMLAnchorElement>();
  const inner = createRef<HTMLAnchorElement>();
  render(
    <Button asChild ref={outer as never}>
      <a ref={inner} href="#x">
        Home
      </a>
    </Button>
  );
  const link = screen.getByRole("link") as HTMLAnchorElement;
  expect(outer.current).toBe(link);
  expect(inner.current).toBe(link);
});

test("an active asChild link runs both click handlers", () => {
  const calls: string[] = [];
  render(
    <Button asChild onClick={() => calls.push("button")}>
      <a href="#x" onClick={() => calls.push("child")}>
        Home
      </a>
    </Button>
  );
  const link = screen.getByRole("link");
  expect(link.hasAttribute("aria-disabled")).toBe(false);
  expect(link.hasAttribute("tabindex")).toBe(false);
  fireEvent.click(link);
  expect(calls).toEqual(["child", "button"]);
});

test.each([
  ["disabled", { disabled: true }, false],
  ["loading", { loading: true }, true],
] as const)("a %s asChild link cannot be activated", (_name, props, busy) => {
  const calls: string[] = [];
  render(
    <Button asChild {...props} onClick={() => calls.push("button")}>
      <a href="#x" onClick={() => calls.push("child")}>
        Home
      </a>
    </Button>
  );
  const link = screen.getByRole("link");
  expect(link.getAttribute("aria-disabled")).toBe("true");
  expect(link.getAttribute("tabindex")).toBe("-1");
  expect(link.className.split(" ")).toContain("aria-disabled:pointer-events-none");
  expect(link.hasAttribute("aria-busy")).toBe(busy);

  const notPrevented = fireEvent.click(link);
  expect(notPrevented).toBe(false);
  expect(calls).toEqual([]);
});
