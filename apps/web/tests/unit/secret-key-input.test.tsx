import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { fireEvent, render, screen } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";
import SecretKeyInput from "@/components/account-entry/SecretKeyInput";
import { isValidSecretKey } from "@/lib/utils/validation";
import { expectFocused } from "./fixtures/focus";

afterEach(() => mock.restore());

const TYPED = "aaaaaaaa";

const held = { current: "" };

beforeEach(() => {
  held.current = "";
});

function Harness({ onValidity }: { onValidity?: (valid: boolean) => void }): ReactElement {
  return <SecretKeyInput secretKeyRef={held} onValidityChange={onValidity} />;
}

function field(): HTMLInputElement {
  return screen.getByPlaceholderText("S...") as HTMLInputElement;
}

function expectNoCopyInMarkup(container: HTMLElement, typed: string = TYPED): void {
  const input = field();
  expect(input.getAttribute("value")).toBeNull();
  expect(input.defaultValue).toBe("");
  expect(input.outerHTML).not.toContain(typed);
  expect(container.innerHTML).not.toContain(typed);
  for (const element of Array.from(container.querySelectorAll("*"))) {
    for (const attribute of Array.from(element.attributes)) {
      expect(attribute.value).not.toContain(typed);
    }
  }
}

function toggle(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Show secret key" }) as HTMLButtonElement;
}

function describedText(input: HTMLElement): string {
  return (input.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
}

function type(value: string): void {
  fireEvent.input(field(), { target: { value } });
}

test("an input event leaves no copy of the key in any attribute", () => {
  const { container } = render(<Harness />);
  type(TYPED);
  expect(field().value).toBe(TYPED);
  expectNoCopyInMarkup(container);
});

test("revealing and hiding the key leaves no copy of it in any attribute", () => {
  const { container } = render(<Harness />);
  type(TYPED);

  fireEvent.click(toggle());
  expect(field().type).toBe("text");
  expect(field().value).toBe(TYPED);
  expectNoCopyInMarkup(container);

  fireEvent.click(toggle());
  expect(field().type).toBe("password");
  expect(field().value).toBe(TYPED);
  expectNoCopyInMarkup(container);
});

test("the error state leaves no copy of the key in any attribute or message", () => {
  const { container } = render(<Harness />);
  type(TYPED);
  fireEvent.blur(field());

  expect(screen.getByRole("alert").textContent).not.toContain(TYPED);
  expectNoCopyInMarkup(container);
});

test("the caller's ref receives what was entered, without surrounding whitespace", () => {
  render(<Harness />);
  type(` ${TYPED} `);
  expect(held.current).toBe(TYPED);
});

test("a pasted key with a trailing newline is accepted as the key", () => {
  const secret = Keypair.random().secret();
  const reports: boolean[] = [];
  render(<Harness onValidity={(valid) => reports.push(valid)} />);
  type(`${secret}\n`);
  expect(reports).toEqual([true]);
  expect(held.current).toBe(secret);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("validity is reported without the key", () => {
  const reports: unknown[][] = [];
  render(<Harness onValidity={(...args) => reports.push(args)} />);
  type(TYPED);
  expect(reports).toEqual([[false]]);
});

test("nothing is logged or persisted", () => {
  const logged: unknown[] = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    spyOn(console, method).mockImplementation((...args: unknown[]) => void logged.push(...args));
  }
  localStorage.clear();
  sessionStorage.clear();

  render(<Harness />);
  type(TYPED);
  fireEvent.blur(field());

  expect(JSON.stringify(logged.map(String))).not.toContain(TYPED);
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
});

test("a value the browser restored before hydration is cleared, matching the empty UI", () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  container.innerHTML = renderToString(<Harness />);
  (container.querySelector("input") as HTMLInputElement).value = TYPED;

  render(<Harness />, { container, hydrate: true });

  expect(field().value).toBe("");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(held.current).toBe("");
  container.remove();
});

test("the field is named, and its error is one alert it points at", () => {
  render(<Harness />);
  const input = screen.getByLabelText(/Secret key/);
  expect(input).toBe(field());

  type(TYPED);
  fireEvent.blur(input);

  const alert = screen.getByRole("alert");
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect((input.getAttribute("aria-describedby") as string).split(" ")).toContain(alert.id);
});

test("the input keeps its protections", () => {
  render(<Harness />);
  const input = field();
  expect(input.type).toBe("password");
  expect(input.getAttribute("autocomplete")).toBe("off");
  expect(input.getAttribute("spellcheck")).toBe("false");
  expect(input.getAttribute("autocorrect")).toBe("off");
  expect(input.getAttribute("autocapitalize")).toBe("none");
});

test("the reveal toggle is a named, tabbable toggle button that reports its state", async () => {
  render(<Harness />);
  const button = toggle();
  expect(button.tagName).toBe("BUTTON");
  expect(button.type).toBe("button");
  expect(button.hasAttribute("tabindex")).toBe(false);
  expect(button.getAttribute("aria-pressed")).toBe("false");
  expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");

  button.focus();
  await expectFocused(button);

  fireEvent.click(button);
  expect(toggle().getAttribute("aria-pressed")).toBe("true");
  expect(field().type).toBe("text");
  fireEvent.click(toggle());
  expect(toggle().getAttribute("aria-pressed")).toBe("false");
  expect(field().type).toBe("password");
});

test("a valid key is described as valid without the key reaching the page", () => {
  const secret = Keypair.random().secret();
  const { container } = render(<Harness />);
  type(secret);
  fireEvent.blur(field());
  fireEvent.click(toggle());
  fireEvent.click(toggle());

  expect(describedText(field())).toContain("Valid secret key");
  expect(describedText(field())).not.toContain(secret);
  expect(screen.queryByRole("alert")).toBeNull();
  expectNoCopyInMarkup(container, secret);
  for (const icon of Array.from(container.querySelectorAll("svg"))) {
    expect(icon.getAttribute("aria-hidden")).toBe("true");
  }
});

test("an invalid key is not described as valid", () => {
  render(<Harness />);
  type(TYPED);
  fireEvent.blur(field());
  expect(describedText(field())).not.toContain("Valid secret key");
});

// Synthetic placeholders, never a parseable key: each is asserted invalid where it is used.
const UNFINISHED = "SABC";
const FULL_LENGTH_INVALID = `S${"A".repeat(55)}`;

test("a value that can never become a key is flagged while typing, before the field is left", () => {
  render(<Harness />);
  type(TYPED);
  expect(screen.getByRole("alert").textContent).toContain("Not a valid Stellar secret key");
  expect(field().getAttribute("aria-invalid")).toBe("true");
});

test("a key still being typed is not flagged until the field is left", () => {
  render(<Harness />);
  type(UNFINISHED);
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.blur(field());
  expect(screen.getByRole("alert")).toBeDefined();
});

test("a full-length value that does not parse is flagged while typing", () => {
  expect(isValidSecretKey(FULL_LENGTH_INVALID)).toBe(false);
  render(<Harness />);
  type(FULL_LENGTH_INVALID);
  expect(screen.getByRole("alert")).toBeDefined();
});

test("a valid key says so in visible text as it is entered, and in the field's description", () => {
  const secret = Keypair.random().secret();
  render(<Harness />);
  type(secret);

  const visible = screen.getByText("Valid secret key", { selector: "p" });
  expect(visible.className).not.toContain("sr-only");
  expect(visible.getAttribute("aria-hidden")).toBe("true");
  expect(describedText(field())).toContain("Valid secret key");
  expect(screen.queryByRole("alert")).toBeNull();
});

test("the field states that the key controls the account, and that it stays in memory", () => {
  render(<Harness />);
  const described = describedText(field());
  expect(described).toContain("Anyone who has this key controls the account.");
  expect(described).toContain("held in memory only, never persisted");
});

test("a partly typed key leaves the caller's ref when the field goes", () => {
  const { unmount } = render(<Harness />);
  type(Keypair.random().secret().slice(0, 55));
  expect(held.current).toHaveLength(55);
  unmount();
  expect(held.current).toBe("");
});
