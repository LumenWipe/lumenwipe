import { afterEach, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import AssetDispositionCard from "@/components/plan/AssetDispositionCard";
import type { AssetConvertibility } from "@/lib/api/plan-adapters";

afterEach(cleanup);

const NOTE = /can reclaim this balance at any time/;

function renderCard(item: Partial<AssetConvertibility>) {
  return render(
    <AssetDispositionCard
      item={{ asset: "USDC:GISSUER", code: "USDC", balance: "5", convertible: true, ...item }}
      disposition={undefined}
      transferDestination={undefined}
      mergeDestination={null}
      onSetDisposition={() => {}}
      onSetTransferDestination={() => {}}
    />
  );
}

for (const convertible of [true, false]) {
  const branch = convertible ? "swappable" : "no-route";

  test(`a clawback-enabled ${branch} asset shows the issuer note`, () => {
    renderCard({ convertible, clawbackEnabled: true });
    expect(screen.getByText(NOTE).textContent).toBe(
      "The issuer of USDC can reclaim this balance at any time, including before the close completes."
    );
  });

  test(`a ${branch} asset without clawback shows no note`, () => {
    renderCard({ convertible });
    expect(screen.queryByText(NOTE)).toBeNull();
  });
}

test("a dust balance reads as too small to swap, not as a missing market", () => {
  renderCard({ convertible: false, dust: true, balance: "0.0000001" });
  expect(screen.getByText("too small to swap")).toBeTruthy();
  expect(screen.queryByText("no swap route on the DEX")).toBeNull();
  expect(screen.getByText(/below the smallest amount the market will swap/)).toBeTruthy();
});

test("an asset with no market keeps the no-route wording", () => {
  renderCard({ convertible: false });
  expect(screen.getByText("no swap route on the DEX")).toBeTruthy();
  expect(screen.queryByText("too small to swap")).toBeNull();
});

function renderAnswered(item: Partial<AssetConvertibility>, disposition?: "convert" | "transfer") {
  return render(
    <AssetDispositionCard
      item={{ asset: "USDC:GISSUER", code: "USDC", balance: "5", convertible: true, ...item }}
      disposition={disposition}
      transferDestination={undefined}
      mergeDestination={null}
      onSetDisposition={() => {}}
      onSetTransferDestination={() => {}}
    />
  );
}

const QUOTE = { estimatedReceive: "20000000", minAmountOut: "19000000" };
const NO_QUOTE =
  "No swap quote is available for USDC right now, so it cannot be swapped in this close. Send it to another account, or refresh the plan to look for a quote again.";

// A swap with no minimum is refused at review and at signing, so the card never offers it, and
// never reads as a swap to XLM.
for (const disposition of [undefined, "convert"] as const) {
  test(`with no quote the card offers no swap and says why (answer: ${disposition ?? "none"})`, () => {
    renderAnswered({}, disposition);
    expect(screen.queryByRole("radio", { name: /^Swap my 5 USDC to XLM/ })).toBeNull();
    expect(screen.getByRole("radio", { name: /^Send my 5 USDC to another account/ })).toBeTruthy();
    expect(screen.getByText("no swap quote")).toBeTruthy();
    expect(screen.getByText(NO_QUOTE)).toBeTruthy();
    expect(screen.queryByText(/swapped to XLM on the DEX/)).toBeNull();
    expect(screen.queryByText("Swap")).toBeNull();
  });
}

test("with a quote the card offers the swap and reads as one", () => {
  renderAnswered({ quote: QUOTE }, "convert");
  expect(screen.getByRole("radio", { name: /^Swap my 5 USDC to XLM/ })).toBeTruthy();
  expect(screen.queryByText(NO_QUOTE)).toBeNull();
  expect(screen.getByText(/swapped to XLM on the DEX/)).toBeTruthy();
});

test("with no quote an answered send reads as a send, not as the missing quote", () => {
  renderAnswered({}, "transfer");
  expect(screen.queryByText(NO_QUOTE)).toBeNull();
  expect(screen.getByText(/sent as USDC, not swapped/)).toBeTruthy();
});
