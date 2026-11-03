import { expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { Badge } from "@/components/ui/badge";

test.each([
  ["neutral", "text-fg-muted"],
  ["accent", "text-accent"],
  ["value", "text-value"],
  ["success", "text-success"],
  ["warning", "text-warning"],
  ["danger", "text-danger-fg"],
] as const)("the %s tone renders its token text color at 12px", (tone, color) => {
  render(<Badge tone={tone}>Label</Badge>);
  const list = screen.getByText("Label").className.split(" ");
  expect(list).toContain(color);
  expect(list).toContain("text-xs");
  expect(list.join(" ")).not.toMatch(/(amber|red|emerald)-\d/);
});

test("the caller's className is merged", () => {
  render(<Badge className="uppercase">Label</Badge>);
  expect(screen.getByText("Label").className.split(" ")).toContain("uppercase");
});
