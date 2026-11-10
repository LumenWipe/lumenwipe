import { afterEach, expect, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import AssetDispositionCard from "@/components/plan/AssetDispositionCard";
import TokenDispositionCard from "@/components/plan/TokenDispositionCard";
import { StatefulPlanAccordion } from "./fixtures/plan-accordion";
import type { AssetConvertibility } from "@/lib/api/plan-adapters";
import type { AccountState, Trustline } from "@/types/account";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";

afterEach(cleanup);

const ISSUER_A = "GAAAAISSUERONE00000000000000000000000000000000000000AAAA";
const ISSUER_B = "GBBBBISSUERTWO00000000000000000000000000000000000000BBBB";
const CONTRACT = "CTOKENCONTRACT000000000000000000000000000000000000000CCCC";
const SOURCE = "GSOURCE0000000000000000000000000000000000000000000000000";

function classic(issuer: string, over: Partial<AssetConvertibility> = {}): AssetConvertibility {
  return {
    asset: `USDC:${issuer}`,
    code: "USDC",
    issuer,
    balance: "5",
    convertible: true,
    ...over,
  };
}

function renderAsset(item: AssetConvertibility) {
  return render(
    <AssetDispositionCard
      network="mainnet"
      item={item}
      disposition="convert"
      transferDestination={undefined}
      mergeDestination={null}
      onSetDisposition={() => {}}
      onSetTransferDestination={() => {}}
    />
  );
}

test("two assets with one code show two different issuers", () => {
  const { container } = render(
    <>
      <div data-testid="a">
        <AssetDispositionCard
          network="mainnet"
          item={classic(ISSUER_A)}
          disposition="convert"
          transferDestination={undefined}
          mergeDestination={null}
          onSetDisposition={() => {}}
          onSetTransferDestination={() => {}}
        />
      </div>
      <div data-testid="b">
        <AssetDispositionCard
          network="mainnet"
          item={classic(ISSUER_B, { convertible: false })}
          disposition={undefined}
          transferDestination={undefined}
          mergeDestination={null}
          onSetDisposition={() => {}}
          onSetTransferDestination={() => {}}
        />
      </div>
    </>
  );
  const a = within(screen.getByTestId("a")).getByText("GAAA…AAAA");
  const b = within(screen.getByTestId("b")).getByText("GBBB…BBBB");
  expect(a.textContent).not.toBe(b.textContent);
  expect(a.getAttribute("title")).toBe(ISSUER_A);
  expect(b.getAttribute("title")).toBe(ISSUER_B);
  expect(container.textContent).toContain("Issued by");
});

test("the copy button copies the full issuer and is named for it", async () => {
  const writeText = spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  renderAsset(classic(ISSUER_A));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Copy USDC issuer address" }));
  });
  expect(writeText).toHaveBeenCalledWith(ISSUER_A);
  expect(screen.getByRole("status").textContent).toBe("Copied the USDC issuer address.");
  writeText.mockRestore();
});

test("a failed copy says so", async () => {
  const writeText = spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
  renderAsset(classic(ISSUER_A));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Copy USDC issuer address" }));
  });
  expect(screen.getByRole("status").textContent).toBe("Could not copy the USDC issuer address.");
  writeText.mockRestore();
});

test("with a quote the swap card shows the expected and least XLM", () => {
  renderAsset(
    classic(ISSUER_A, { quote: { estimatedReceive: "20000000", minAmountOut: "19000000" } })
  );
  expect(screen.getByText(/About 2 XLM, at least 1\.881 XLM\./)).toBeTruthy();
  expect(screen.queryByText(/Estimate unavailable/)).toBeNull();
});

test("an asset only an exit pays in says the estimate is unavailable", () => {
  renderAsset(classic(ISSUER_A, { arrivesFromExit: true }));
  expect(screen.getByText(/Estimate unavailable\./)).toBeTruthy();
  expect(screen.queryByText(/About .* XLM, at least/)).toBeNull();
});

test("a token card shows its contract with a copy button", () => {
  render(
    <TokenDispositionCard
      network="mainnet"
      item={{
        asset: CONTRACT,
        code: "TKN",
        balance: "1",
        convertible: false,
        token: {
          contract: CONTRACT,
          symbol: "TKN",
          decimals: 7,
          rawBalance: "10000000",
          arrivesFromExit: false,
        },
      }}
      disposition={undefined}
      transferDestination={undefined}
      mergeDestination={null}
      onSetDisposition={() => {}}
      onSetTransferDestination={() => {}}
      impactConfirmed={false}
      onConfirmImpact={() => {}}
    />
  );
  expect(screen.getByText("CTOK…CCCC").getAttribute("title")).toBe(CONTRACT);
  expect(screen.getByRole("button", { name: "Copy TKN contract address" })).toBeTruthy();
});

test("the trustline list shows each issuer, so lines sharing a code differ", () => {
  const line = (issuer: string): Trustline => ({
    asset: `USDC:${issuer}`,
    code: "USDC",
    issuer,
    balance: "0.0000000",
    limit: "1000",
    authorized: true,
    authorization: "authorized",
    clawbackEnabled: false,
  });
  const account: AccountState = {
    address: SOURCE,
    network: "testnet",
    sequence: "1",
    nativeBalanceLumens: "10.0000000",
    dataEntries: [],
    signers: [],
    thresholds: { low: 0, med: 0, high: 0 },
    numSubEntries: 2,
    numSponsoring: 0,
    sponsoredEntries: [],
    sponsorshipEnumerationIncomplete: false,
    sponsoredBy: null,
    authImmutable: false,
    trustlines: [line(ISSUER_A), line(ISSUER_B)],
    openOffers: [],
    poolShares: [],
    claimableBalances: [],
    subEntryMismatch: false,
    defiPositions: emptyDefiPositionsResult(SOURCE),
    defiPositionsWarnings: [],
  };
  render(
    <StatefulPlanAccordion
      network="mainnet"
      account={account}
      conversions={[]}
      assetDispositions={{}}
      transferDestinations={{}}
      mergeDestination={null}
      onSetDisposition={() => {}}
      onSetTransferDestination={() => {}}
      isImpactConfirmed={() => false}
      onConfirmImpact={() => {}}
      claimableBalanceDecisions={[]}
      claimableBalanceSelections={{}}
      onSelectClaimableBalance={() => {}}
      destinationAddress={null}
      mediatorRequired={false}
    />
  );
  expect(screen.getByText("GAAA…AAAA").getAttribute("title")).toBe(ISSUER_A);
  expect(screen.getByText("GBBB…BBBB").getAttribute("title")).toBe(ISSUER_B);
});
