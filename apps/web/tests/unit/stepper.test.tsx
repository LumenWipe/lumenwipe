import { afterEach, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { Stepper } from "@/components/ui/stepper";

afterEach(cleanup);

const STEPS = ["Decide", "Review", "Sign", "Done"];

function current(container: HTMLElement): Element[] {
  return Array.from(container.querySelectorAll("[aria-current]"));
}

test.each([0, 1, 3])("step %i alone carries aria-current", (index) => {
  const { container } = render(<Stepper steps={STEPS} current={index} />);
  const marked = current(container);
  expect(marked).toHaveLength(1);
  expect(marked[0].getAttribute("aria-current")).toBe("step");
  expect(marked[0].textContent).toContain(STEPS[index]);
});

test.each(["done", "failed", "blocked"] as const)(
  "a %s current step still carries aria-current",
  (status) => {
    const { container } = render(<Stepper steps={STEPS} current={2} status={status} />);
    expect(current(container)).toHaveLength(1);
  }
);

test.each([-1, 4, 99])("an out-of-range index %i still marks exactly one step", (index) => {
  const { container } = render(<Stepper steps={STEPS} current={index} />);
  expect(current(container)).toHaveLength(1);
});

test("the compact label swaps with the list at md", () => {
  const { container } = render(<Stepper steps={STEPS} current={1} />);
  const compact = screen.getByText("Step 2 of 4: Review");
  expect(compact.className.split(" ")).toContain("md:hidden");
  expect((container.querySelector("ol") as Element).className.split(" ")).toEqual(
    expect.arrayContaining(["hidden", "md:flex"])
  );
});

test("the compact label names a state that is not plain progress", () => {
  render(<Stepper steps={STEPS} current={2} status="failed" />);
  expect(screen.getByText("Step 3 of 4: Sign (Failed)")).toBeTruthy();
});

test("every step states its progress in text, not only with an icon", () => {
  const { container } = render(<Stepper steps={STEPS} current={1} status="blocked" />);
  expect(Array.from(container.querySelectorAll("li")).map((li) => li.textContent)).toEqual([
    "Decide(Done)",
    "Review(Blocked)",
    "Sign(Pending)",
    "Done(Pending)",
  ]);
});

test.each([
  ["active", "Current"],
  ["done", "Done"],
  ["failed", "Failed"],
  ["blocked", "Blocked"],
] as const)("status %s reads as %s on the current step", (status, text) => {
  const { container } = render(<Stepper steps={STEPS} current={0} status={status} />);
  expect(container.querySelector("[aria-current]")?.textContent).toBe(`Decide(${text})`);
});

test("no steps renders nothing", () => {
  const { container } = render(<Stepper steps={[]} current={0} />);
  expect(container.firstChild).toBeNull();
});
