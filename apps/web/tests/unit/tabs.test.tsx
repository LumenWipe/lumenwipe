import { afterEach, expect, mock, test } from "bun:test";
import { useState, type ReactElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Tabs, type TabItem } from "@/components/ui/tabs";
import { expectFocused } from "./fixtures/focus";

afterEach(cleanup);

type Value = "one" | "two" | "three";

const ITEMS: readonly TabItem<Value>[] = [
  { value: "one", label: "One" },
  { value: "two", label: "Two" },
  { value: "three", label: "Three" },
];

function Harness({
  items = ITEMS,
  initial = "one",
  onChange,
}: {
  items?: readonly TabItem<Value>[];
  initial?: Value;
  onChange?: (value: Value) => void;
}): ReactElement {
  const [value, setValue] = useState<Value>(initial);
  return (
    <Tabs
      label="Pick one"
      items={items}
      value={value}
      onValueChange={(next) => {
        onChange?.(next);
        setValue(next);
      }}
    >
      <p>panel {value}</p>
    </Tabs>
  );
}

function tab(name: string): HTMLButtonElement {
  return screen.getByRole("tab", { name }) as HTMLButtonElement;
}

function selectedNames(): (string | null)[] {
  return screen
    .getAllByRole("tab")
    .filter((el) => el.getAttribute("aria-selected") === "true")
    .map((el) => el.textContent);
}

test("exposes a named tablist, one selected tab and a panel labelled by it", () => {
  render(<Harness />);
  expect(screen.getByRole("tablist", { name: "Pick one" })).toBeTruthy();
  expect(selectedNames()).toEqual(["One"]);

  const panel = screen.getByRole("tabpanel", { name: "One" });
  expect(panel.textContent).toBe("panel one");
  expect(tab("Two").getAttribute("aria-controls")).toBe(panel.id);
});

test("only the selected tab is in the tab order", () => {
  render(<Harness initial="two" />);
  expect(screen.getAllByRole("tab").map((el) => el.getAttribute("tabindex"))).toEqual([
    "-1",
    "0",
    "-1",
  ]);
});

test.each([
  ["ArrowRight", "one", "two"],
  ["ArrowRight", "three", "one"],
  ["ArrowLeft", "two", "one"],
  ["ArrowLeft", "one", "three"],
  ["Home", "three", "one"],
  ["End", "one", "three"],
] as const)("%s from %s selects and focuses %s", async (key, from, to) => {
  const onChange = mock((_: Value) => {});
  render(<Harness initial={from} onChange={onChange} />);
  const name = to[0].toUpperCase() + to.slice(1);
  const start = screen.getAllByRole("tab").find((el) => el.getAttribute("tabindex") === "0");

  const notPrevented = fireEvent.keyDown(start as Element, { key });

  expect(notPrevented).toBe(false);
  expect(onChange.mock.calls).toEqual([[to]]);
  expect(selectedNames()).toEqual([name]);
  await expectFocused(tab(name));
});

test.each(["Enter", "a", "ArrowDown", "Tab"])("%s changes nothing", (key) => {
  const onChange = mock((_: Value) => {});
  render(<Harness onChange={onChange} />);
  expect(fireEvent.keyDown(tab("One"), { key })).toBe(true);
  expect(onChange).not.toHaveBeenCalled();
});

test.each([{ altKey: true }, { metaKey: true }, { ctrlKey: true }])(
  "an arrow held with a browser modifier is left to the browser: %p",
  (modifier) => {
    const onChange = mock((_: Value) => {});
    render(<Harness onChange={onChange} />);
    expect(fireEvent.keyDown(tab("One"), { key: "ArrowLeft", ...modifier })).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  }
);

test("arrows and End skip a disabled tab", () => {
  const onChange = mock((_: Value) => {});
  const items = ITEMS.map((item) => (item.value === "two" ? { ...item, disabled: true } : item));
  render(<Harness items={items} onChange={onChange} />);

  fireEvent.keyDown(tab("One"), { key: "ArrowRight" });
  expect(selectedNames()).toEqual(["Three"]);
  fireEvent.keyDown(tab("Three"), { key: "ArrowLeft" });
  expect(selectedNames()).toEqual(["One"]);

  expect(onChange.mock.calls).toEqual([["three"], ["one"]]);
});

test("Home and End land on the first and last enabled tabs", () => {
  const items = ITEMS.map((item) =>
    item.value === "two" ? item : { ...item, disabled: item.value === "one" }
  );
  render(<Harness items={items} initial="two" />);
  fireEvent.keyDown(tab("Two"), { key: "End" });
  expect(selectedNames()).toEqual(["Three"]);
  fireEvent.keyDown(tab("Three"), { key: "Home" });
  expect(selectedNames()).toEqual(["Two"]);
});

test("a disabled tab ignores clicks and is natively disabled", () => {
  const onChange = mock((_: Value) => {});
  const items = ITEMS.map((item) => (item.value === "two" ? { ...item, disabled: true } : item));
  render(<Harness items={items} onChange={onChange} />);
  expect(tab("Two").disabled).toBe(true);
  fireEvent.click(tab("Two"));
  expect(onChange).not.toHaveBeenCalled();
});

test("when the selected tab is disabled the tab stop moves to the first enabled tab", () => {
  const items = ITEMS.map((item) => (item.value === "one" ? { ...item, disabled: true } : item));
  render(<Harness items={items} />);
  expect(tab("Two").getAttribute("tabindex")).toBe("0");
  expect(tab("One").getAttribute("tabindex")).toBe("-1");
  expect(selectedNames()).toEqual(["One"]);
});

test("every tab disabled leaves no tab stop and no keyboard move", () => {
  const onChange = mock((_: Value) => {});
  const items = ITEMS.map((item) => ({ ...item, disabled: true }));
  render(<Harness items={items} onChange={onChange} />);
  for (const el of screen.getAllByRole("tab")) expect(el.getAttribute("tabindex")).toBe("-1");
  fireEvent.keyDown(tab("One"), { key: "ArrowRight" });
  expect(onChange).not.toHaveBeenCalled();
});

test("a click fires even on the selected tab", () => {
  const onChange = mock((_: Value) => {});
  render(<Harness onChange={onChange} />);
  fireEvent.click(tab("One"));
  expect(onChange.mock.calls).toEqual([["one"]]);
});

test("an icon does not change the tab's name", () => {
  render(<Harness items={[{ value: "one", label: "One", icon: <svg aria-hidden="true" /> }]} />);
  expect(tab("One").querySelector("svg")).toBeTruthy();
});
