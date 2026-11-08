import { test, expect } from "bun:test";
import { render, screen } from "@testing-library/react";
import BlockersPanel from "@/components/plan/BlockersPanel";
import { hardBlockersOf } from "@/lib/plan/resolvable-blockers";

// The API's own wording for a path an operator switched off. The web adds nothing of its own: it
// shows the message as a blocker that stops the close, and never the code behind it.
const PAUSED = [
  {
    code: "exchange_forward_paused",
    message:
      "Closing into an exchange is paused right now. Choose a wallet you control as the destination, or try again later.",
  },
  {
    code: "mediator_not_configured",
    message:
      "Closing into an exchange is not available on this network. Choose a wallet you control as the destination.",
  },
  {
    code: "fee_sponsorship_paused",
    message:
      "Fee sponsorship is paused right now. This account needs 0.0000200 XLM more above its reserve to pay its own network fees. Add that much XLM, or try again later.",
  },
  {
    code: "defi_exit_paused",
    message:
      "Exits from Blend are paused right now, so the Blend position in CAJJ…BXBD cannot be closed, and the account cannot be merged while it stays open. Try again later.",
  },
  {
    code: "soroban_token_conversion_unavailable",
    message:
      "Converting XTAR to XLM is paused right now. Send it to another account, leave it on record, or try again later.",
  },
];

test("every paused path stops the close", () => {
  expect(hardBlockersOf(PAUSED)).toEqual(PAUSED);
});

test.each(PAUSED)("$code renders as a plain-language blocker with no raw code", (blocker) => {
  const { container } = render(<BlockersPanel blockers={[blocker]} blocking={true} />);
  expect(screen.getByText("Cannot proceed - blockers found")).toBeDefined();
  expect(screen.getByText(blocker.message)).toBeDefined();
  expect(container.textContent).not.toContain(blocker.code);
  expect(container.textContent).not.toMatch(/_ENABLED|[a-z]+_[a-z]+/);
});
