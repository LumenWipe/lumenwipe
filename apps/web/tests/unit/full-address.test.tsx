import { afterEach, expect, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";
import { FullAddress, groupAddress } from "@/components/ui/full-address";
import type { AccountState } from "@/types/account";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";
import { StatefulPlanAccordion } from "./fixtures/plan-accordion";

const ADDRESS = Keypair.random().publicKey();

afterEach(cleanup);

/** The text a screen reader is given: everything not hidden from it. */
function accessibleText(root: Element): string {
  const clone = root.cloneNode(true) as Element;
  clone.querySelectorAll('[aria-hidden="true"]').forEach((el) => el.remove());
  return clone.textContent ?? "";
}

test("groups of four keep every character, with no middle truncation", () => {
  const groups = groupAddress(ADDRESS);
  expect(groups).toHaveLength(14);
  expect(groups.every((g) => g.length === 4)).toBe(true);
  expect(groups.join("")).toBe(ADDRESS);
});

test("the address is shown whole, in groups, and read as one string", () => {
  const { container } = render(<FullAddress value={ADDRESS} label="destination address" />);
  const visible = container.querySelector('[aria-hidden="true"]') as HTMLElement;

  expect(visible.children).toHaveLength(14);
  expect(visible.textContent).toBe(ADDRESS);
  expect(container.textContent).not.toContain("…");
  expect(accessibleText(container).trim()).toBe(ADDRESS);
});

test("copy copies the raw address", async () => {
  const writeText = spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  render(<FullAddress value={ADDRESS} label="destination address" />);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Copy destination address" }));
  });
  expect(writeText).toHaveBeenCalledWith(ADDRESS);
  expect(screen.getByRole("status").textContent).toBe("Copied the destination address.");
  writeText.mockRestore();
});

test("the merge step shows the destination whole, and only the closed account is shortened", () => {
  const source = Keypair.random().publicKey();
  const { container } = render(
    <StatefulPlanAccordion
      network="mainnet"
      initialOpen="MERGE"
      account={
        {
          address: source,
          network: "testnet",
          sequence: "1",
          nativeBalanceLumens: "10.0000000",
          dataEntries: [],
          signers: [],
          thresholds: { low: 0, med: 0, high: 0 },
          numSubEntries: 0,
          numSponsoring: 0,
          sponsoredEntries: [],
          sponsorshipEnumerationIncomplete: false,
          sponsoredBy: null,
          authImmutable: false,
          trustlines: [],
          openOffers: [],
          poolShares: [],
          claimableBalances: [],
          subEntryMismatch: false,
          defiPositions: emptyDefiPositionsResult(source),
          defiPositionsWarnings: [],
        } as AccountState
      }
      conversions={[]}
      assetDispositions={{}}
      transferDestinations={{}}
      mergeDestination={ADDRESS}
      onSetDisposition={() => {}}
      onSetTransferDestination={() => {}}
      isImpactConfirmed={() => false}
      onConfirmImpact={() => {}}
      claimableBalanceDecisions={[]}
      claimableBalanceSelections={{}}
      onSelectClaimableBalance={() => {}}
      destinationAddress={ADDRESS}
      mediatorRequired={false}
    />
  );
  expect(accessibleText(container)).toContain(ADDRESS);
  expect(container.textContent).not.toContain(`${ADDRESS.slice(0, 8)}…`);
  expect(screen.getByRole("button", { name: "Copy destination address" })).toBeTruthy();
});
