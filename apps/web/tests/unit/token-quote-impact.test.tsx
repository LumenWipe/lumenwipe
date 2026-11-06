/**
 * A flagged token conversion (a high or unmeasured price impact, or quotes that disagree) is
 * shown with why, is never recommended, and is accepted only by a confirmation tied to the floor
 * the user saw. A token with no quote says why it has none.
 */
import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import TokenDispositionCard from "@/components/plan/TokenDispositionCard";
import AccountSummaryCard from "@/components/plan/AccountSummaryCard";
import {
  decisionPointsToConversions,
  type AssetConvertibility,
  type TokenQuote,
} from "@/lib/api/plan-adapters";
import {
  closeDecisions,
  conversionImpactAcknowledgementsToDecisions,
  isConversionImpactConfirmed,
} from "@/lib/api/close-decisions";
import { assetsResolved } from "@/lib/plan/asset-resolution";
import { expectedReceive } from "@/lib/plan/expected-receive";
import type { PlanResponse } from "@lumenwipe/sdk";
import type { AccountState } from "@/types/account";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";

afterEach(cleanup);

const CONTRACT = "CBI7UCH5KGSVQRO5H4SUCZUTZABCITZLRHQQZTWL2TK4RZ72TAR6IHRV";
const DEST = "GBWLBY2XERGCNM5UWRIF5ZG6LM7Q7B44MHUR54BT3XVHAD5IB4HLN3XG";

function quote(over: Partial<TokenQuote> = {}): TokenQuote {
  return {
    amountOut: "50000000",
    minAmountOut: "49750000",
    platform: "aggregator",
    route: ["soroswap"],
    provider: "soroswap",
    priceImpactBps: 2_450,
    flags: ["high_impact"],
    ...over,
  };
}

function tokenItem(over: Partial<NonNullable<AssetConvertibility["token"]>> = {}) {
  const convertible = over.quote !== undefined;
  return {
    asset: CONTRACT,
    code: "XTAR",
    balance: "250",
    convertible,
    token: {
      contract: CONTRACT,
      symbol: "XTAR",
      decimals: 7,
      rawBalance: "2500000000",
      arrivesFromExit: false,
      ...over,
    },
  } satisfies AssetConvertibility;
}

function renderCard(
  item: AssetConvertibility,
  disposition: "convert" | undefined,
  onConfirmImpact: (asset: string, confirmed: boolean) => void = () => {},
  impactConfirmed = false
) {
  return render(
    <TokenDispositionCard
      item={item}
      disposition={disposition}
      transferDestination={undefined}
      mergeDestination={null}
      onSetDisposition={() => {}}
      onSetTransferDestination={() => {}}
      impactConfirmed={impactConfirmed}
      onConfirmImpact={onConfirmImpact}
    />
  );
}

function planWith(subject: Record<string, unknown>): PlanResponse {
  return {
    decisionPoints: [
      {
        id: `token:${CONTRACT}`,
        type: "asset_disposition",
        subject: {
          kind: "soroban_token",
          contract: CONTRACT,
          symbol: "XTAR",
          decimals: 7,
          balance: "2500000000",
          ...subject,
        },
        options: subject.quote
          ? [{ id: "convert_to_xlm" }, { id: "transfer_to_account" }]
          : [{ id: "transfer_to_account" }],
        default: "transfer_to_account",
        required: true,
      },
    ],
  } as unknown as PlanResponse;
}

test("the adapter reads the impact, the flags, the runner-up and the reason", () => {
  const [flagged] = decisionPointsToConversions(
    planWith({
      quote: {
        ...quote({ flags: ["provider_disagreement"], priceImpactBps: 40 }),
        runnerUp: { provider: "xbull", amountOut: "40000000", minAmountOut: "39800000" },
      },
    })
  );
  expect(flagged!.token?.quote).toMatchObject({
    priceImpactBps: 40,
    flags: ["provider_disagreement"],
    runnerUp: { provider: "xbull", amountOut: "40000000" },
  });
  const [unquoted] = decisionPointsToConversions(planWith({ reason: "provider_unavailable" }));
  expect(unquoted!.token?.reason).toBe("provider_unavailable");
  const [unknownReason] = decisionPointsToConversions(planWith({ reason: "something_new" }));
  expect(unknownReason!.token).not.toHaveProperty("reason");
});

test("a flag the client cannot read, or flags that are not a list, count as an unmeasured impact", () => {
  for (const flags of [["high_impact", "brand_new"], "high_impact", 3]) {
    const [c] = decisionPointsToConversions(planWith({ quote: { ...quote(), flags } }));
    expect(c!.token?.quote?.flags).toContain("impact_unknown");
  }
  const [negative] = decisionPointsToConversions(
    planWith({ quote: { ...quote(), priceImpactBps: -5 } })
  );
  expect(negative!.token?.quote?.priceImpactBps).toBeNull();
});

test("a flagged quote shows why, is not tagged recommended, and asks for a confirmation naming the floor", () => {
  const confirmed: boolean[] = [];
  renderCard(tokenItem({ quote: quote() }), "convert", (_, c) => confirmed.push(c));
  expect(screen.getByText("Needs your confirmation")).toBeTruthy();
  expect(screen.queryByText("Recommended")).toBeNull();
  expect(
    screen.getByText(
      /much less than the current market price suggests: a price impact of about 24\.5%/
    )
  ).toBeTruthy();
  const box = screen.getByRole("checkbox", {
    name: /still want to exchange my 250 XTAR for at least 4\.975 XLM/,
  });
  fireEvent.click(box);
  expect(confirmed).toEqual([true]);
  // Not confirmed: the card still needs a decision.
  expect(screen.getByText("Decide")).toBeTruthy();
});

test("a confirmed flagged conversion reads as a swap", () => {
  renderCard(tokenItem({ quote: quote() }), "convert", () => {}, true);
  expect(screen.getByText("Swap")).toBeTruthy();
});

test("disagreeing providers and an unmeasured impact each explain themselves", () => {
  renderCard(
    tokenItem({
      quote: quote({
        flags: ["provider_disagreement"],
        priceImpactBps: 30,
        runnerUp: { provider: "xbull", amountOut: "40000000", minAmountOut: "39800000" },
      }),
    }),
    "convert"
  );
  expect(screen.getByText(/Soroswap quotes about 5 XLM, xBull about 4 XLM/)).toBeTruthy();
  cleanup();
  renderCard(
    tokenItem({ quote: quote({ flags: ["impact_unknown"], priceImpactBps: null }) }),
    "convert"
  );
  expect(screen.getByText(/price impact of this swap could not be measured/)).toBeTruthy();
});

test("an unflagged quote is unchanged: recommended, with its impact, and no confirmation", () => {
  renderCard(tokenItem({ quote: quote({ flags: [], priceImpactBps: 12 }) }), "convert");
  expect(screen.getByText("Recommended")).toBeTruthy();
  expect(screen.getByText(/at a price impact of about 0\.12%/)).toBeTruthy();
  expect(screen.queryByRole("checkbox")).toBeNull();
});

test("a token beyond the quote limit, one with a provider error and one with no route each have distinct copy", () => {
  const copies: string[] = [];
  for (const reason of ["quote_limit", "provider_unavailable", "no_route"] as const) {
    renderCard(tokenItem({ reason }), undefined);
    copies.push(screen.getByTestId(`token-card-${CONTRACT}`).textContent ?? "");
    cleanup();
  }
  expect(copies[0]).toContain("more Soroban tokens than one plan prices");
  expect(copies[1]).toContain("did not answer in time");
  expect(copies[1]).toContain("Analyze again");
  expect(copies[2]).toContain("There is no route to exchange this token");
  expect(new Set(copies).size).toBe(3);
});

test("a flagged token is resolved only by a convert confirmed at the floor it carries, or by transfer or leave", () => {
  const conversions = [tokenItem({ quote: quote() })];
  const floors = { [CONTRACT]: { minAmountOut: "49750000", provider: "soroswap" as const } };
  const base = {
    conversions,
    balanceBearingCount: 1,
    transferDestinations: {},
    tokenConversionFloors: floors,
  };
  expect(assetsResolved({ ...base, dispositions: {} })).toBe(false);
  expect(assetsResolved({ ...base, dispositions: { [CONTRACT]: "convert" } })).toBe(false);
  expect(
    assetsResolved({
      ...base,
      dispositions: { [CONTRACT]: "convert" },
      conversionImpactAcknowledgedFor: { [CONTRACT]: "40000000" },
    })
  ).toBe(false);
  expect(
    assetsResolved({
      ...base,
      dispositions: { [CONTRACT]: "convert" },
      conversionImpactAcknowledgedFor: { [CONTRACT]: "49750000" },
    })
  ).toBe(true);
  expect(assetsResolved({ ...base, dispositions: { [CONTRACT]: "leave" } })).toBe(true);
  expect(
    assetsResolved({
      ...base,
      dispositions: { [CONTRACT]: "transfer" },
      transferDestinations: { [CONTRACT]: DEST },
    })
  ).toBe(true);
});

test("the confirmation travels only with a convert answer and only for the floor it was given for", () => {
  const floors = { [CONTRACT]: { minAmountOut: "49750000", provider: "soroswap" as const } };
  expect(isConversionImpactConfirmed(CONTRACT, floors, { [CONTRACT]: "49750000" })).toBe(true);
  expect(isConversionImpactConfirmed(CONTRACT, {}, { [CONTRACT]: "49750000" })).toBe(false);
  expect(
    conversionImpactAcknowledgementsToDecisions({ [CONTRACT]: "convert" }, floors, {
      [CONTRACT]: "49750000",
    })
  ).toEqual([
    {
      id: `conversion_impact:${CONTRACT}`,
      choice: "acknowledged",
      params: { minAmountOut: "49750000" },
    },
  ]);
  expect(
    conversionImpactAcknowledgementsToDecisions({ [CONTRACT]: "leave" }, floors, {
      [CONTRACT]: "49750000",
    })
  ).toEqual([]);
  expect(
    conversionImpactAcknowledgementsToDecisions({ [CONTRACT]: "convert" }, floors, {
      [CONTRACT]: "1",
    })
  ).toEqual([]);
  const decisions = closeDecisions(
    {
      assetDispositions: { [CONTRACT]: "convert" },
      transferDestinations: {},
      tokenConversionFloors: floors,
      classicConversionFloors: {},
      claimableBalanceSelections: {},
      destinationAcknowledgedFor: null,
      defiPositionsAcknowledgedFor: null,
      issuerSupplyAcknowledgedFor: null,
      conversionImpactAcknowledgedFor: { [CONTRACT]: "49750000" },
      positionsLeftBehind: [],
    },
    "GSOURCE",
    "GDEST",
    []
  );
  const convert = decisions.find((d) => d.id === `token:${CONTRACT}`);
  const ack = decisions.find((d) => d.id === `conversion_impact:${CONTRACT}`);
  expect(ack?.params?.minAmountOut).toBe(convert?.params?.minAmountOut);
});

test("the expected figure names the flagged swaps the user confirmed, on analyze and review alike", () => {
  const account: AccountState = {
    address: "GSOURCE",
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
    defiPositions: emptyDefiPositionsResult("GSOURCE"),
    defiPositionsWarnings: [],
  };
  const expected = expectedReceive({
    account,
    planFeeStroops: "100",
    relayForwardUncounted: false,
    conversions: [tokenItem({ quote: quote() })],
    dispositions: { [CONTRACT]: "convert" },
    claims: [],
    claimSelections: {},
  });
  expect(expected.flaggedSwaps).toBe(1);
  render(<AccountSummaryCard account={account} destinationAddress={null} expected={expected} />);
  expect(screen.getByText(/One swap you confirmed was flagged on its card/)).toBeTruthy();
});
