import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import DefiPositionsAcknowledgement from "@/components/plan/DefiPositionsAcknowledgement";

afterEach(cleanup);

test("after a completed sweep it states what the sweep found and asks about the trustlines", () => {
  render(
    <DefiPositionsAcknowledgement
      sweepCompleted={true}
      acknowledged={false}
      onAcknowledgedChange={() => {}}
    />
  );
  expect(screen.getByText("Confirm what this account's trustlines are for.")).toBeDefined();
  expect(screen.getByText(/found no open DeFi positions in the protocols LumenWipe/)).toBeDefined();
  expect(screen.queryByText(/could not be confirmed/)).toBeNull();
});

test("when the sweep did not complete it never claims an on-chain check found nothing", () => {
  render(
    <DefiPositionsAcknowledgement
      sweepCompleted={false}
      acknowledged={false}
      onAcknowledgedChange={() => {}}
    />
  );
  expect(
    screen.getByText("DeFi position data for this account could not be confirmed.")
  ).toBeDefined();
  expect(screen.getByText(/could not be completed/)).toBeDefined();
  expect(screen.queryByText(/found no open DeFi positions/)).toBeNull();
});

test("ticking the box reports the acknowledgement", () => {
  const onChange = mock(() => {});
  render(
    <DefiPositionsAcknowledgement
      sweepCompleted={true}
      acknowledged={false}
      onAcknowledgedChange={onChange}
    />
  );
  fireEvent.click(screen.getByRole("checkbox"));
  expect(onChange).toHaveBeenCalledWith(true);
});
