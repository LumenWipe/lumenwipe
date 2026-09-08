import { test, expect, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import AllowanceRow from "@/components/allowances/AllowanceRow";
import type { Allowance } from "@/types/allowance";

function allowance(over: Partial<Allowance> = {}): Allowance {
  return {
    token: "CCZGLAUBDKJSQK72QOZHVU7CUWKW45OZWYWCLL27AEK74U2OIBK6LXF2",
    tokenSymbol: "XTAR",
    tokenDecimals: 7,
    spender: "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF",
    spenderProtocol: null,
    amount: "5000000",
    expirationLedger: 1_100_000,
    sources: ["events"],
    ...over,
  };
}

test("AllowanceRow › shows the token symbol, spender, formatted amount, and expiration ledger", () => {
  render(<AllowanceRow allowance={allowance()} onRevoke={() => {}} />);

  expect(screen.getByText("XTAR")).toBeTruthy();
  expect(screen.getByText("0.5")).toBeTruthy();
  expect(screen.getByText(/approved/)).toBeTruthy();
  expect(screen.getByText(/expires at ledger 1100000/)).toBeTruthy();
});

test("AllowanceRow › shows the resolved protocol badge when the spender is a known registry entry", () => {
  render(<AllowanceRow allowance={allowance({ spenderProtocol: "blend" })} onRevoke={() => {}} />);

  expect(screen.getByText("Blend")).toBeTruthy();
});

test("AllowanceRow › shows 'expiration unknown' rather than a fabricated ledger when the source has none", () => {
  render(<AllowanceRow allowance={allowance({ expirationLedger: null })} onRevoke={() => {}} />);

  expect(screen.getByText("expiration unknown")).toBeTruthy();
});

test("AllowanceRow › clicking Revoke calls onRevoke with exactly this allowance", () => {
  const onRevoke = mock((_a: Allowance) => {});
  const item = allowance();
  render(<AllowanceRow allowance={item} onRevoke={onRevoke} />);

  fireEvent.click(screen.getByRole("button", { name: /revoke/i }));

  expect(onRevoke).toHaveBeenCalledTimes(1);
  expect(onRevoke.mock.calls[0]?.[0]).toEqual(item);
});
