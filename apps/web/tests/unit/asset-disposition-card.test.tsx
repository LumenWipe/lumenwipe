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
