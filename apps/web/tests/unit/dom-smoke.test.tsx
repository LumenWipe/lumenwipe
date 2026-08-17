import { test, expect } from "bun:test";
import { render, screen } from "@testing-library/react";

test("dom-smoke › renders into a real DOM via happy-dom", () => {
  render(<div>hello multisig</div>);
  expect(screen.getByText("hello multisig")).toBeDefined();
});
