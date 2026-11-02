import { expect, test } from "bun:test";
import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import { Callout } from "@/components/ui/callout";

const RAW = /(amber|red|emerald|green|yellow)-\d|destructive/;

test.each([
  ["warning", "alert"],
  ["danger", "alert"],
  ["success", "status"],
] as const)("the %s tone announces as %s by default", (tone, role) => {
  render(<Callout tone={tone}>Body</Callout>);
  expect(screen.getByRole(role).textContent).toBe("Body");
});

test("the info tone has no live role", () => {
  const { container } = render(<Callout tone="info">Body</Callout>);
  expect(container.firstElementChild?.hasAttribute("role")).toBe(false);
});

test("announce overrides the tone's role", () => {
  render(
    <Callout tone="warning" announce="status">
      Body
    </Callout>
  );
  expect(screen.getByRole("status")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("announce false renders no live role for a box present at page load", () => {
  const { container } = render(
    <Callout tone="danger" announce={false}>
      Body
    </Callout>
  );
  expect(container.firstElementChild?.hasAttribute("role")).toBe(false);
});

test.each(["info", "success", "warning", "danger"] as const)(
  "the %s tone uses no raw palette class",
  (tone) => {
    const { container } = render(
      <Callout tone={tone} icon={<svg />} title="Title">
        Body
      </Callout>
    );
    expect(container.innerHTML).not.toMatch(RAW);
  }
);

test("danger text and icons use the text token, never the fill", () => {
  render(
    <Callout tone="danger" icon={<svg data-testid="icon" />}>
      Body
    </Callout>
  );
  const body = screen.getByText("Body");
  expect(body.className.split(" ")).toContain("text-danger-fg");
  expect(screen.getByTestId("icon").parentElement?.className.split(" ")).toContain(
    "text-danger-fg"
  );
  expect(body.className).not.toMatch(/(^|\s)text-danger(\s|$)/);
});

test("a title carries the tone and leaves the body neutral", () => {
  render(
    <Callout tone="danger" title="Title">
      Body
    </Callout>
  );
  expect(screen.getByText("Title").className.split(" ")).toContain("text-danger-fg");
  expect(screen.getByText("Body").className.split(" ")).toContain("text-fg-muted");
});

test("the action renders inside the live region", () => {
  render(
    <Callout tone="danger" action={<a href="#x">Go back</a>}>
      Body
    </Callout>
  );
  expect(screen.getByRole("alert").contains(screen.getByRole("link"))).toBe(true);
});

test("the ref, tabIndex and className reach the root for focus management", () => {
  const ref = createRef<HTMLDivElement>();
  render(
    <Callout ref={ref} tone="danger" tabIndex={-1} className="outline-none">
      Body
    </Callout>
  );
  expect(ref.current).toBe(screen.getByRole("alert") as HTMLDivElement);
  expect(ref.current?.getAttribute("tabindex")).toBe("-1");
  expect(ref.current?.className.split(" ")).toContain("outline-none");
});
