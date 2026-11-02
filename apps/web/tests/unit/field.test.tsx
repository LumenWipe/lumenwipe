import { expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { Field, Input, Textarea } from "@/components/ui/field";

function describedByElements(control: HTMLElement): (HTMLElement | null)[] {
  return (control.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter(Boolean)
    .map((id) => document.getElementById(id));
}

test("the label names the control", () => {
  render(
    <Field label="Memo">
      <Input />
    </Field>
  );
  expect(screen.getByLabelText("Memo").tagName).toBe("INPUT");
});

test("a hidden label still names the control", () => {
  render(
    <Field label="Memo" hideLabel>
      <Input />
    </Field>
  );
  expect(screen.getByRole("textbox", { name: "Memo" }).tagName).toBe("INPUT");
});

test("the required marker stays out of the accessible name", () => {
  render(
    <Field label="Memo" required>
      <Input />
    </Field>
  );
  const input = screen.getByRole("textbox", { name: "Memo" });
  expect(input.getAttribute("aria-required")).toBe("true");
});

test("a field with neither helper nor error describes nothing", () => {
  render(
    <Field label="Memo">
      <Input />
    </Field>
  );
  const input = screen.getByLabelText("Memo");
  expect(input.hasAttribute("aria-describedby")).toBe(false);
  expect(input.hasAttribute("aria-invalid")).toBe(false);
});

test("the helper alone is described and raises no alert", () => {
  render(
    <Field label="Memo" helper="Optional">
      <Input />
    </Field>
  );
  const [helper] = describedByElements(screen.getByLabelText("Memo"));
  expect(helper?.textContent).toBe("Optional");
  expect(screen.queryByRole("alert")).toBeNull();
});

test("an error is one alert, marks the control invalid and comes first in its description", () => {
  render(
    <Field label="Memo" helper="Optional" error="Too long">
      <Input />
    </Field>
  );
  const input = screen.getByLabelText("Memo");
  expect(input.getAttribute("aria-invalid")).toBe("true");
  const [error, helper] = describedByElements(input);
  expect(error).toBe(screen.getByRole("alert"));
  expect(error?.textContent).toBe("Too long");
  expect(helper?.textContent).toBe("Optional");
});

test("clearing an error leaves no reference to it", () => {
  const { rerender } = render(
    <Field label="Memo" error="Too long">
      <Input />
    </Field>
  );
  rerender(
    <Field label="Memo">
      <Input />
    </Field>
  );
  expect(screen.getByLabelText("Memo").hasAttribute("aria-describedby")).toBe(false);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("wiring reaches a control nested inside other markup", () => {
  render(
    <Field label="Memo" error="Too long">
      <div>
        <div>
          <Input />
        </div>
      </div>
    </Field>
  );
  expect(describedByElements(screen.getByLabelText("Memo"))[0]).toBe(screen.getByRole("alert"));
});

test("Textarea takes the same wiring as Input", () => {
  render(
    <Field label="Notes" helper="Plain text" error="Required">
      <Textarea />
    </Field>
  );
  const textarea = screen.getByLabelText("Notes");
  expect(textarea.tagName).toBe("TEXTAREA");
  expect(textarea.getAttribute("aria-invalid")).toBe("true");
  expect(describedByElements(textarea).every(Boolean)).toBe(true);
});

test("controls hold the 44px minimum and the 3:1 boundary token", () => {
  render(
    <>
      <Input aria-label="one" />
      <Textarea aria-label="two" />
    </>
  );
  for (const name of ["one", "two"]) {
    const control = screen.getByLabelText(name);
    expect(control.className).toContain("min-h-control");
    expect(control.className).toContain("border-line-strong");
    expect(control.className).not.toContain("md:min-h");
  }
});

test("Input stays usable outside a Field", () => {
  render(<Input aria-label="alone" id="own" />);
  expect(screen.getByLabelText("alone").id).toBe("own");
});
