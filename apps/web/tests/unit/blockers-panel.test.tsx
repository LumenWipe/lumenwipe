import { test, expect } from "bun:test";
import { render, screen } from "@testing-library/react";
import BlockersPanel from "@/components/plan/BlockersPanel";

// Regression coverage for a real production report: an account with a non-trapping DeFi
// blocker (defi_positions_unconfirmed_no_trustlines - a direct on-chain check already confirmed
// nothing, on a zero-trustline account) still rendered "Cannot proceed - blockers found," even
// though "Begin execution" was not actually disabled. The heading must reflect whether anything
// in the list actually blocks, not just whether the list is non-empty.

test("renders nothing when there are no blockers to show", () => {
  const { container } = render(<BlockersPanel blockers={[]} blocking={false} />);
  expect(container.firstChild).toBeNull();
});

test("a hard blocker renders the destructive 'cannot proceed' heading", () => {
  render(
    <BlockersPanel
      blockers={[{ message: "The destination account does not exist." }]}
      blocking={true}
    />
  );
  expect(screen.getByText("Cannot proceed - blockers found")).toBeDefined();
  expect(screen.getByText("The destination account does not exist.")).toBeDefined();
});

test("a non-blocking DeFi note renders its message without claiming the close cannot proceed", () => {
  render(
    <BlockersPanel
      blockers={[
        {
          code: "defi_positions_unconfirmed_no_trustlines",
          message: "DeFi position data could not be confirmed by the indexer…",
        },
      ]}
      blocking={false}
    />
  );
  expect(screen.queryByText("Cannot proceed - blockers found")).toBeNull();
  expect(screen.getByText(/DeFi position data could not be confirmed/)).toBeDefined();
});
