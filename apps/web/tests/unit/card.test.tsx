import { expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { Card, CardBody, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";

test("a card has one surface, one border and one radius and no blur", () => {
  render(<Card data-testid="card">Body</Card>);
  const list = screen.getByTestId("card").className.split(" ");
  for (const c of ["bg-surface", "border-edge/10", "rounded-card"]) expect(list).toContain(c);
  expect(list.join(" ")).not.toMatch(/backdrop|mkt-panel/);
});

test.each([
  ["success", "border-success/20", "bg-success/5"],
  ["warning", "border-warning/30", "bg-warning/5"],
  ["danger", "border-danger/30", "bg-danger/5"],
] as const)("the %s tone changes only border and tint", (tone, border, tint) => {
  render(<Card data-testid="plain" />);
  render(<Card data-testid="toned" tone={tone} />);
  const plain = screen.getByTestId("plain").className.split(" ");
  const toned = screen.getByTestId("toned").className.split(" ");
  expect(toned).toContain(border);
  expect(toned).toContain(tint);
  expect(toned.filter((c) => !plain.includes(c)).sort()).toEqual([border, tint].sort());
});

test("no tone uses a raw palette class", () => {
  for (const tone of ["neutral", "success", "warning", "danger"] as const) {
    const { container, unmount } = render(<Card tone={tone} />);
    expect(container.innerHTML).not.toMatch(/(amber|red|emerald)-\d|destructive/);
    unmount();
  }
});

test("the parts compose and the title is a heading", () => {
  render(
    <Card>
      <CardHeader data-testid="header">
        <CardTitle>Title</CardTitle>
      </CardHeader>
      <CardBody data-testid="body">Body</CardBody>
      <CardFooter data-testid="footer">Footer</CardFooter>
    </Card>
  );
  expect(screen.getByRole("heading", { level: 2, name: "Title" })).toBeTruthy();
  expect(screen.getByTestId("header").className.split(" ")).toContain("border-b");
  expect(screen.getByTestId("body").className.split(" ")).toContain("p-5");
  expect(screen.getByTestId("footer").className.split(" ")).toContain("border-t");
});

test("data attributes and className pass through", () => {
  render(<Card data-testid="card" className="p-3" />);
  expect(screen.getByTestId("card").className.split(" ")).toContain("p-3");
});
