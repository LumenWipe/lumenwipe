import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import IssuerSupplyAcknowledgement from "@/components/plan/IssuerSupplyAcknowledgement";
import { issuerSupplyAcknowledgementToDecisions } from "@/lib/api/close-decisions";

afterEach(cleanup);

const SOURCE = "GSOURCE0000000000000000000000000000000000000000000000000";

test("the plan's wording is shown and ticking the box reports the acknowledgement", () => {
  const onChange = mock(() => {});
  render(
    <IssuerSupplyAcknowledgement
      message="This account issued 2 assets that are still held in 7 trustlines."
      acknowledged={false}
      onAcknowledgedChange={onChange}
    />
  );
  expect(screen.getByText(/issued 2 assets/)).toBeDefined();
  fireEvent.click(screen.getByRole("checkbox"));
  expect(onChange).toHaveBeenCalledWith(true);
});

test("once acknowledged the box stays visible and can be cleared", () => {
  const onChange = mock(() => {});
  render(
    <IssuerSupplyAcknowledgement message={null} acknowledged onAcknowledgedChange={onChange} />
  );
  const box = screen.getByRole("checkbox") as HTMLInputElement;
  expect(box.checked).toBe(true);
  fireEvent.click(box);
  expect(onChange).toHaveBeenCalledWith(false);
});

test("the answer is sent only for the account it was given for", () => {
  expect(issuerSupplyAcknowledgementToDecisions(SOURCE, SOURCE)).toEqual([
    { id: `issuer_supply:${SOURCE}`, choice: "stranding_holders_acknowledged" },
  ]);
  expect(issuerSupplyAcknowledgementToDecisions("GOTHER", SOURCE)).toEqual([]);
  expect(issuerSupplyAcknowledgementToDecisions(null, SOURCE)).toEqual([]);
});
