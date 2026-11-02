import { expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";
import DestinationInput from "@/components/account-entry/DestinationInput";

const noop = (): void => {};

function renderInput(destination: string): void {
  render(
    <DestinationInput
      destination={destination}
      onDestinationChange={noop}
      memo=""
      onMemoChange={noop}
      source={Keypair.random().publicKey()}
      acknowledged={false}
      onAcknowledgedChange={noop}
    />
  );
}

test("an unrecognized destination raises one alert carrying the warning and its checkbox", () => {
  renderInput(Keypair.random().publicKey());

  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain("We don't recognize this address");
  expect(alert.contains(screen.getByRole("checkbox"))).toBe(true);
});

test("no alert is raised before the destination is a valid address", () => {
  renderInput("GABC");
  expect(screen.queryByRole("alert")).toBeNull();
});
