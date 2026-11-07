import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act, render, screen, within } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";
import * as navigation from "next/navigation";
import ReviewView from "@/components/review/ReviewView";
import { expectedReceive } from "@/lib/plan/expected-receive";
import { useDemolishStore } from "@/store/demolish";
import { useNetworkStore } from "@/store/network";
import type { AccountState, Trustline } from "@/types/account";
import type { PlannedStep } from "@/types/plan";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";

const SOURCE = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const FRIEND = Keypair.random().publicKey();
const ISSUER_A = Keypair.random().publicKey();
const ISSUER_B = Keypair.random().publicKey();
const USDC_A = `USDC:${ISSUER_A}`;
const USDC_B = `USDC:${ISSUER_B}`;
const FOO = `FOO:${ISSUER_A}`;

function trustline(code: string, issuer: string, balance: string): Trustline {
  return {
    asset: `${code}:${issuer}`,
    code,
    issuer,
    balance,
    authorized: true,
    authorization: "authorized",
    clawbackEnabled: false,
  } as Trustline;
}

function account(): AccountState {
  return {
    address: SOURCE,
    network: "testnet",
    sequence: "1",
    nativeBalanceLumens: "30.0000000",
    dataEntries: [],
    signers: [],
    thresholds: { low: 0, med: 0, high: 0 },
    numSubEntries: 4,
    numSponsoring: 0,
    sponsoredEntries: [],
    sponsorshipEnumerationIncomplete: false,
    sponsoredBy: null,
    authImmutable: false,
    trustlines: [
      trustline("USDC", ISSUER_A, "5.0000000"),
      trustline("USDC", ISSUER_B, "2.0000000"),
      trustline("FOO", ISSUER_A, "7.0000000"),
    ],
    openOffers: [],
    poolShares: [],
    claimableBalances: [
      {
        id: "cb1",
        asset: USDC_A,
        amount: "1.5000000",
        claimants: [{ destination: SOURCE, predicate: { type: "unconditional" } }],
        sponsor: null,
      },
    ],
    subEntryMismatch: false,
    defiPositions: emptyDefiPositionsResult(SOURCE),
    defiPositionsWarnings: [],
  } as AccountState;
}

const STEPS: PlannedStep[] = [
  {
    index: 0,
    type: "HANDLE_ASSETS",
    title: "Handle assets",
    description: "",
    operationCount: 3,
    estimatedFeeLumens: "0.0000300",
    txXdr: null,
    status: "pending",
    txHash: null,
    error: null,
  },
  {
    index: 1,
    type: "MERGE",
    title: "Merge account",
    description: "",
    operationCount: 1,
    estimatedFeeLumens: "0.0000100",
    txXdr: null,
    status: "pending",
    txHash: null,
    error: null,
  },
];

beforeEach(() => {
  spyOn(navigation, "useRouter").mockImplementation(
    () =>
      ({ push: () => {}, replace: () => {} }) as unknown as ReturnType<typeof navigation.useRouter>
  );
  useNetworkStore.setState({ network: "testnet" });
  const store = useDemolishStore.getState();
  store.reset();
  store.setAddresses(SOURCE, DEST);
  store.setAccountState(account());
  store.setAssetDisposition(USDC_A, "convert");
  store.setAssetDisposition(USDC_B, "transfer");
  store.setTransferDestination(USDC_B, FRIEND);
  store.setAssetDisposition(FOO, "issuer");
  store.setClassicConversionFloors({ [USDC_A]: { minAmountOut: "19800000" } });
  store.setClaimableBalanceSelection("cb1", "forfeit");
  store.setPlan(STEPS, "h");
  store.setExpectedReceive(
    expectedReceive({
      account: account(),
      planFeeStroops: "400",
      relayForwardUncounted: false,
      conversions: [
        {
          asset: USDC_A,
          code: "USDC",
          issuer: ISSUER_A,
          balance: "5",
          convertible: true,
          quote: { estimatedReceive: "20000000", minAmountOut: "20000000" },
        },
      ],
      dispositions: useDemolishStore.getState().assetDispositions,
      claims: [],
      claimSelections: {},
    })
  );
});

afterEach(() => mock.restore());

async function show(): Promise<HTMLElement[]> {
  await act(async () => {
    render(<ReviewView network="testnet" />);
  });
  return screen.getAllByTestId("asset-outcome");
}

const action = (row: HTMLElement) => within(row).getByTestId("asset-outcome-action");

test("a swap, a transfer, a return to issuer and a forfeited claim each get one correct row", async () => {
  const [swap, transfer, issuer, forfeit, ...rest] = await show();
  expect(rest).toHaveLength(0);

  expect(action(swap).textContent).toBe(
    "Swapped to XLM: you receive at least 1.98 XLM (the least the plan quoted)."
  );
  expect(action(swap).className).not.toContain("text-danger-fg");

  const shown = [...transfer.querySelectorAll('[aria-hidden="true"]')].map((g) => g.textContent);
  expect(shown).toContain(FRIEND);
  expect(action(transfer).textContent).toContain("Sent to");

  expect(action(issuer).textContent).toBe(
    "Returned to its issuer. You are giving up 7 FOO permanently."
  );
  expect(action(issuer).className).toContain("text-danger-fg");
  expect(within(issuer).getByText("Given up")).toBeDefined();

  expect(within(forfeit).getByText("Claimable 1.5 USDC")).toBeDefined();
  expect(action(forfeit).textContent).toMatch(/^Left unclaimed\. You are giving up 1\.5 USDC/);
  expect(action(forfeit).className).toContain("text-danger-fg");
  expect(within(forfeit).getByText("Given up")).toBeDefined();
});

test("two USDC rows show their two different issuers", async () => {
  const [swap, transfer] = await show();
  const issuerOf = (row: HTMLElement) =>
    [...row.querySelectorAll('[aria-hidden="true"]')]
      .map((g) => g.textContent)
      .find((t) => t?.startsWith("G"));
  expect(issuerOf(swap)).toBe(ISSUER_A);
  expect(issuerOf(transfer)).toBe(ISSUER_B);
});

test("a classic swap without a quote says so and adds nothing", async () => {
  useDemolishStore.getState().setClassicConversionFloors({});
  const [swap] = await show();
  expect(action(swap).textContent).toContain("minimum not available");
});

test("the net estimate equals the hero figure, and its fee is the review's one fee", async () => {
  await show();
  const total = screen.getByTestId("net-estimate-total").textContent ?? "";
  const hero = screen.getByTestId("hero-receive").textContent ?? "";
  const figure = total.replace("You will receive about", "").trim();
  // 30 XLM - 0.00004 (the steps' fees) + 1.98 (the swap's floor)
  expect(figure).toBe("31.97996 XLM");
  expect(hero).toContain(figure);
  const net = screen.getByTestId("net-estimate").textContent ?? "";
  expect(net).toContain("- 0.00004 XLM");
  expect(net).toContain("+ 1.98 XLM");
  expect(screen.getByTestId("fee-summary").textContent).toContain("0.00004 XLM");
  expect(net).toContain("How we calculate this");
});

test("with a step fee that cannot be read, the net estimate is not shown as a figure", async () => {
  useDemolishStore.getState().setPlan([STEPS[0], { ...STEPS[1], estimatedFeeLumens: "n/a" }], "h");
  await show();
  expect(screen.getByTestId("net-estimate").textContent).toBe(
    "The amount you will receive could not be estimated for this plan."
  );
  expect(screen.queryByTestId("net-estimate-total")).toBeNull();
  expect(screen.getByTestId("hero-receive").textContent).toBe(
    "The amount you will receive could not be estimated for this plan."
  );
});

test("issuers are shown in full on the review", async () => {
  const [swap] = await show();
  expect(swap.textContent).not.toContain("…");
});

test("a transfer with no destination recorded says so", async () => {
  useDemolishStore.getState().setTransferDestination(USDC_B, null);
  const [, transfer] = await show();
  expect(action(transfer).textContent).toBe("No destination recorded for this transfer.");
});

test("when the fees are more than the balance, 0 XLM is shown with a warning, never a negative", async () => {
  const expected = useDemolishStore.getState().expectedReceive!;
  useDemolishStore
    .getState()
    .setExpectedReceive({ ...expected, balanceStroops: "100", swapStroops: "0" });
  await show();
  const hero = screen.getByTestId("hero-receive").textContent ?? "";
  const total = screen.getByTestId("net-estimate-total").textContent ?? "";
  expect(hero).toContain("0 XLM");
  expect(hero).not.toContain("-");
  expect(total).toBe("You will receive about0 XLM");
  expect(hero).toContain("more than this account's balance would cover");
  expect(screen.getByTestId("net-estimate").textContent).toContain(
    "more than this account's balance would cover"
  );
});
