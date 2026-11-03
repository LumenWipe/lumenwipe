import { afterEach, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import ProgressIndicator from "@/components/execution/ProgressIndicator";

afterEach(cleanup);

const STATUS = "Submitting to Stellar network…";

test("shows the status text it is given, verbatim", () => {
  render(<ProgressIndicator status={STATUS} />);
  expect(screen.getByText(STATUS).textContent).toBe(STATUS);
});

test("the status stays out of the accessibility tree, leaving the spinner's label", () => {
  const { container } = render(<ProgressIndicator status={STATUS} />);
  const exposed = Array.from(container.querySelectorAll("span:not([aria-hidden])")).map(
    (el) => el.textContent
  );
  expect(exposed).toEqual(["In progress"]);
  expect(screen.getByText(STATUS).getAttribute("aria-hidden")).toBe("true");
  expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  expect(screen.queryByRole("status")).toBeNull();
});
