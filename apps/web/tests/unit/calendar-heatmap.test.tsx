import { afterEach, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import CalendarHeatmap from "@/components/marketing/stats/CalendarHeatmap";

afterEach(cleanup);

test("the scrolling grid is a named region in the tab order", () => {
  render(<CalendarHeatmap feed={null} />);
  const region = screen.getByRole("region", { name: "Activity heatmap, last 12 months" });
  expect(region.tabIndex).toBe(0);
  expect(region.className).toContain("overflow-x-auto");
});
