import { expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { DecisionCard, type DecisionOption } from "@/components/ui/decision-card";

type Choice = "keep" | "drop";

const OPTIONS: DecisionOption<Choice>[] = [
  { value: "keep", label: "Keep it.", tag: { label: "Recommended", tone: "success" } },
  {
    value: "drop",
    label: "Drop it.",
    detail: "Gone for good.",
    notice: "Dropping cannot be undone.",
    children: <p>drop details</p>,
  },
];

function renderCard(value: Choice | undefined, onValueChange = mock((_: Choice) => {})) {
  render(
    <DecisionCard
      legend="What happens to it"
      options={OPTIONS}
      value={value}
      onValueChange={onValueChange}
      tone="neutral"
    >
      <p>summary</p>
    </DecisionCard>
  );
  return onValueChange;
}

test("the options are native radios in one named group", () => {
  renderCard(undefined);
  const group = screen.getByRole("group", { name: "What happens to it" });
  const radios = within(group).getAllByRole("radio") as HTMLInputElement[];
  expect(radios.map((r) => r.tagName)).toEqual(["INPUT", "INPUT"]);
  expect(new Set(radios.map((r) => r.name)).size).toBe(1);
  expect(radios[0].name).not.toBe("");
});

test("each option is named by its outcome, tag and detail", () => {
  renderCard(undefined);
  expect(screen.getByRole("radio", { name: "Keep it. Recommended" })).toBeTruthy();
  expect(screen.getByRole("radio", { name: "Drop it. Gone for good." })).toBeTruthy();
});

test("nothing is checked while the value is unset", () => {
  renderCard(undefined);
  expect(screen.getAllByRole("radio").some((r) => (r as HTMLInputElement).checked)).toBe(false);
});

test("the checked option follows the value", () => {
  renderCard("drop");
  expect((screen.getByRole("radio", { name: /^Drop it/ }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByRole("radio", { name: /^Keep it/ }) as HTMLInputElement).checked).toBe(false);
});

test("choosing an option reports its value once", () => {
  const onValueChange = renderCard("keep");
  fireEvent.click(screen.getByRole("radio", { name: /^Drop it/ }));
  expect(onValueChange.mock.calls).toEqual([["drop"]]);
});

test("the notice and the extra content show only while their option is selected", () => {
  renderCard("keep");
  expect(screen.queryByText("Dropping cannot be undone.")).toBeNull();
  expect(screen.queryByText("drop details")).toBeNull();
  cleanup();
  renderCard("drop");
  expect(screen.getByRole("status").textContent).toBe("Dropping cannot be undone.");
  expect(screen.getByText("drop details")).toBeTruthy();
});
