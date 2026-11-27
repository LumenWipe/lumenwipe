import { test, expect } from "bun:test";
import { render, screen } from "@testing-library/react";
import BlockersPanel from "@/components/plan/BlockersPanel";

// Regression coverage for a real production report: an account with a non-trapping DeFi
// blocker (defi_positions_unconfirmed_no_trustlines - a direct on-chain check already confirmed
// nothing, on a zero-trustline account) still rendered "Cannot proceed - blockers found," even
// though "Begin execution" was not actually disabled. The heading must reflect whether anything
// in the list actually blocks, not just whether the list is non-empty. A completed on-chain sweep
// is a finding, so it renders as verified rather than as something to check.

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
          code: "defi_positions_unconfirmed_user_verified",
          message: "You confirmed manually that this account's trustlines are for other assets.",
        },
      ]}
      blocking={false}
    />
  );
  expect(screen.queryByText("Cannot proceed - blockers found")).toBeNull();
  expect(screen.getByText("Needs verification")).toBeDefined();
  expect(screen.getByText(/You confirmed manually/)).toBeDefined();
});

const HELP_URL = "https://stellar.expert/explorer/public/account/GABC";

function expectVerifiedOnly(message: string) {
  expect(screen.getByText("Verified on-chain")).toBeDefined();
  expect(screen.getByText(message)).toBeDefined();
  expect(screen.queryByText("Needs verification")).toBeNull();
  expect(screen.queryByText("Cannot proceed - blockers found")).toBeNull();
  expect(screen.queryByText(/could not be confirmed/)).toBeNull();
  expect(screen.getByText("Learn more").closest("details")).not.toBeNull();
  expect(screen.getByText(/covers the DeFi protocols LumenWipe recognizes/)).toBeDefined();
  expect(screen.getByRole("link", { name: /Open in explorer/ }).getAttribute("href")).toBe(
    HELP_URL
  );
}

test("a confirmed sweep with positions reads as verified on-chain, with the scope caveat under Learn more", () => {
  const message =
    "A direct on-chain check found 1 DeFi position (shown below), and this close includes its exit.";
  render(
    <BlockersPanel
      blockers={[{ code: "defi_positions_unconfirmed_but_detected", message, helpUrl: HELP_URL }]}
      blocking={false}
    />
  );
  expectVerifiedOnly(message);
});

test("a confirmed empty sweep reads as verified on-chain", () => {
  const message =
    "A direct on-chain check found no open DeFi positions in the protocols LumenWipe recognizes, and this account holds no trustlines, which rules out every classic liquidity pool position.";
  render(
    <BlockersPanel
      blockers={[{ code: "defi_positions_unconfirmed_no_trustlines", message, helpUrl: HELP_URL }]}
      blocking={false}
    />
  );
  expectVerifiedOnly(message);
});

test("a failed or partial sweep keeps the blocking warning", () => {
  const unavailable = {
    code: "defi_positions_unavailable",
    message: "DeFi position data for this account could not be confirmed.",
    helpUrl: HELP_URL,
  };
  const { unmount } = render(<BlockersPanel blockers={[unavailable]} blocking={true} />);
  expect(screen.getByText("Cannot proceed - blockers found")).toBeDefined();
  expect(screen.queryByText("Verified on-chain")).toBeNull();
  unmount();

  render(<BlockersPanel blockers={[unavailable]} blocking={false} />);
  expect(screen.getByText("Needs verification")).toBeDefined();
  expect(screen.queryByText("Verified on-chain")).toBeNull();
});

test("a verified note and a hard blocker each keep their own panel", () => {
  render(
    <BlockersPanel
      blockers={[
        { message: "The destination account does not exist." },
        { code: "defi_positions_unconfirmed_but_detected", message: "Found 1 position." },
      ]}
      blocking={true}
    />
  );
  expect(screen.getByText("Cannot proceed - blockers found")).toBeDefined();
  expect(screen.getByText("Verified on-chain")).toBeDefined();
  expect(screen.queryByRole("link", { name: /Open in explorer/ })).toBeNull();
});
