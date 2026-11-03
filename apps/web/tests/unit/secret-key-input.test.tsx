import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { fireEvent, render, screen } from "@testing-library/react";
import SecretKeyInput from "@/components/account-entry/SecretKeyInput";

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

function expectNoCopyInMarkup(container: HTMLElement): void {
  const input = field();
  expect(input.getAttribute("value")).toBeNull();
  expect(input.defaultValue).toBe("");
  expect(input.outerHTML).not.toContain(TYPED);
  expect(container.innerHTML).not.toContain(TYPED);
  for (const attribute of Array.from(input.attributes)) {
    expect(attribute.value).not.toContain(TYPED);
  }
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
  const toggle = container.querySelector("button") as HTMLButtonElement;

  fireEvent.click(toggle);
  expect(field().type).toBe("text");
  expect(field().value).toBe(TYPED);
  expectNoCopyInMarkup(container);

  fireEvent.click(toggle);
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

test("the caller's ref receives exactly what was entered", () => {
  render(<Harness />);
  type(` ${TYPED} `);
  expect(held.current).toBe(` ${TYPED} `);
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
