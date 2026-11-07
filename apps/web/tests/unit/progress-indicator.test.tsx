import { afterEach, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import ProgressIndicator from "@/components/execution/ProgressIndicator";
import { STILL_WAITING } from "@/lib/execution/progress";

afterEach(cleanup);

const LINE = "Transaction 2 of 3: approve in your wallet";

/** Text a screen reader can reach: outside every aria-hidden subtree. */
function exposedText(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("span"))
    .filter((el) => el.closest("[aria-hidden='true']") === null)
    .map((el) => el.textContent ?? "");
}

test("shows the line it is given, verbatim", () => {
  render(<ProgressIndicator line={LINE} stalled={false} elapsedSeconds={3} />);
  expect(screen.getByText(LINE).textContent).toBe(LINE);
  expect(screen.queryByText(/0:03/)).toBeNull();
});

test("the line stays out of the accessibility tree, leaving the spinner's label", () => {
  const { container } = render(<ProgressIndicator line={LINE} stalled elapsedSeconds={25} />);
  expect(exposedText(container)).toEqual(["In progress"]);
  expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  expect(screen.queryByRole("status")).toBeNull();
});

test("a stalled wait says so, with how long it has waited", () => {
  const { container } = render(<ProgressIndicator line={LINE} stalled elapsedSeconds={25} />);
  expect(container.textContent).toContain(`${STILL_WAITING} 0:25`);
});

test("showTimer shows the elapsed time before the wait stalls", () => {
  const { container } = render(
    <ProgressIndicator line={LINE} stalled={false} elapsedSeconds={7} showTimer />
  );
  expect(container.textContent).toContain("0:07");
  expect(container.textContent).not.toContain(STILL_WAITING);
});
