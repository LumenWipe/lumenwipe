import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";
import * as navigation from "next/navigation";
import AnalyzePage from "@/app/[network]/analyze/page";
import PlanView from "@/components/plan/PlanView";
import type { AssetConvertibility } from "@/lib/api/plan-adapters";
import { signatureOf } from "@/lib/plan/plan-freshness";
import { refreshReviewedPlan } from "@/lib/plan/refresh-plan";
import { DECISIONS_VERSION, type DecisionSnapshot } from "@/lib/session/decision-snapshot";
import { PLAN_FLOOR_MISSING } from "@/lib/utils/user-error";
import { useDemolishStore } from "@/store/demolish";
import { useNetworkStore } from "@/store/network";
import type { AccountState } from "@/types/account";
import type { AssetDisposition, PlannedStep } from "@/types/plan";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";
import { freshAccount, freshPlan } from "./fixtures/fresh-plan";
import { expectFocused } from "./fixtures/focus";

// The review refuses a swap with no minimum ("A swap in this plan has no minimum amount
// recorded") and sends the user back to analyze. These tests hold analyze to the same rule, so
// the user is asked there, once, and the round trip between the two screens cannot repeat.

const SOURCE = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const PAYEE = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const NOQ = `NOQ:${ISSUER}`;
const KEY = `lumenwipe:decisions:testnet:${SOURCE}`;
const QUOTE = { estimatedReceive: "20000000", minAmountOut: "19000000" };
const NAMED =
  "No swap quote is available for NOQ, so it cannot be swapped in this close. Choose another answer for it, or refresh the plan";

const STEP: PlannedStep = {
  index: 0,
  type: "MERGE",
  title: "MERGE",
  description: "",
  operationCount: 1,
  estimatedFeeLumens: "0.0000100",
  txXdr: null,
  status: "pending",
  txHash: null,
  error: null,
};

function account(): AccountState {
  return freshAccount(SOURCE, {
    numSubEntries: 1,
    trustlines: [
      {
        asset: NOQ,
        code: "NOQ",
        issuer: ISSUER,
        balance: "5.0000000",
        limit: "1000",
        buyingLiabilities: "0",
        sellingLiabilities: "0",
      },
    ] as unknown as AccountState["trustlines"],
    defiPositions: emptyDefiPositionsResult(SOURCE),
  });
}

/** The plan offers converting NOQ, but no quote the client can read comes with it. */
function unquotedPlan(quote?: typeof QUOTE) {
  return freshPlan([STEP], {
    planHash: "c".repeat(64),
    decisionPoints: [
      {
        id: `asset:NOQ-${ISSUER}`,
        type: "asset_disposition",
        subject: {
          kind: "trustline",
          asset: NOQ,
          balance: "5.0000000",
          convertible: true,
          arrivesFromExit: false,
          ...(quote ? { quote } : {}),
        },
        options: [{ id: "convert_to_xlm" }, { id: "transfer_to_account" }],
        default: "convert_to_xlm",
        required: true,
      },
    ],
  } as never);
}

const reasons = (): string[] => {
  const list = screen.queryByRole("list", { name: "Before you can review" });
  return list
    ? within(list)
        .getAllByRole("listitem")
        .map((li) => li.textContent ?? "")
    : [];
};
const proceedButton = (): HTMLButtonElement =>
  screen.getByRole("button", { name: /^Review the full plan/ }) as HTMLButtonElement;
const click = async (el: HTMLElement): Promise<void> => {
  await act(async () => {
    fireEvent.click(el);
  });
};
const type = async (el: HTMLElement, value: string): Promise<void> => {
  await act(async () => {
    fireEvent.change(el, { target: { value } });
  });
};

beforeEach(() => {
  window.sessionStorage.clear();
  useDemolishStore.getState().reset();
  useNetworkStore.setState({ network: "testnet" });
  const router = { push: () => {}, replace: () => {} };
  spyOn(navigation, "useRouter").mockImplementation(() => router as never);
  spyOn(navigation, "useSearchParams").mockImplementation(
    () => new URLSearchParams(`source=${SOURCE}`) as never
  );
});

afterEach(() => {
  cleanup();
  mock.restore();
  window.sessionStorage.clear();
});

describe("a convertible asset with no quote, on PlanView", () => {
  const UNQUOTED: AssetConvertibility = {
    asset: NOQ,
    code: "NOQ",
    issuer: ISSUER,
    balance: "5.0000000",
    convertible: true,
  };

  function view(conversions: AssetConvertibility[]) {
    return (
      <PlanView
        account={account()}
        conversions={conversions}
        claimableBalanceDecisions={[]}
        blockers={[]}
        planFeeStroops={null}
        network="testnet"
        onRefresh={() => {}}
        loading={false}
      />
    );
  }

  test("is never answered convert for the user, and is named as the reason the button waits", async () => {
    await act(async () => {
      render(view([UNQUOTED]));
    });
    expect(useDemolishStore.getState().assetDispositions).toEqual({});
    expect(useDemolishStore.getState().classicConversionFloors).toEqual({});
    expect(proceedButton().disabled).toBe(true);
    expect(reasons()).toEqual([NAMED, "Enter a destination"]);
    expect(screen.getByText("Handle assets").closest("button")?.textContent ?? "").toContain(
      "Needs your answer (1)"
    );
  });

  test("the named reason moves focus into the asset's card", async () => {
    await act(async () => {
      render(view([UNQUOTED]));
    });
    await click(screen.getByRole("button", { name: NAMED }));
    // The card's first control, as for any jump to an asset card with nothing checked yet.
    const card = document.querySelector(`[data-open-item="asset:${NOQ}"]`) as HTMLElement;
    await expectFocused(within(card).getByRole("button", { name: "Copy NOQ issuer address" }));
  });

  test("the same asset with a quote is still answered convert, with its floor", async () => {
    await act(async () => {
      render(view([{ ...UNQUOTED, quote: QUOTE }]));
    });
    expect(useDemolishStore.getState().assetDispositions).toEqual({ [NOQ]: "convert" });
    expect(useDemolishStore.getState().classicConversionFloors).toEqual({
      [NOQ]: { minAmountOut: "18810000" },
    });
    expect(reasons()).toEqual(["Enter a destination"]);
  });

  // The invariant behind the round trip: whenever analyze lets the user through, no convert
  // answer lacks the floor the review checks for.
  const ITEMS: Record<string, AssetConvertibility> = {
    unquoted: UNQUOTED,
    quoted: { ...UNQUOTED, quote: QUOTE },
    "exit-only": { ...UNQUOTED, arrivesFromExit: true },
    "no route": { ...UNQUOTED, convertible: false },
  };
  const ANSWERS: Record<string, AssetDisposition | undefined> = {
    none: undefined,
    convert: "convert",
    transfer: "transfer",
    issuer: "issuer",
  };
  for (const [itemName, item] of Object.entries(ITEMS)) {
    for (const [answerName, answer] of Object.entries(ANSWERS)) {
      test(`an enabled button never leaves a convert unfloored (${itemName}, ${answerName})`, async () => {
        const store = useDemolishStore.getState();
        if (answer) store.setAssetDisposition(NOQ, answer);
        if (answer === "transfer") store.setTransferDestination(NOQ, PAYEE);
        store.acknowledgeDestination(DEST);
        await act(async () => {
          render(view([item]));
        });
        await type(screen.getByRole("textbox", { name: /Destination address/ }), DEST);
        const unfloored = signatureOf(
          freshPlan([STEP]),
          account(),
          useDemolishStore.getState()
        ).unflooredConverts;
        if (!proceedButton().disabled) expect(unfloored).toEqual([]);
        // An unquoted convert is never the state the page is left in with the button enabled.
        if (itemName === "unquoted" && (answer === undefined || answer === "convert")) {
          expect(proceedButton().disabled).toBe(true);
          expect(reasons()).toEqual([NAMED]);
        }
      });
    }
  }
});

describe("analyze, review, confirm", () => {
  let plan = unquotedPlan();

  function stubFetch(): void {
    spyOn(globalThis, "fetch").mockImplementation((async (input: unknown) => {
      const url = String(input);
      if (url.includes("/close/plan")) return Response.json(plan);
      if (url.includes("/account/")) return Response.json(account());
      return Response.json({});
    }) as unknown as typeof fetch);
  }

  async function analyzed(): Promise<void> {
    const params = Object.assign(Promise.resolve({ network: "testnet" as const }), {
      status: "fulfilled",
      value: { network: "testnet" as const },
    });
    await act(async () => {
      render(<AnalyzePage params={params} />);
    });
    await waitFor(() => expect(screen.getByText("Account analyzed")).toBeTruthy());
  }

  function restoring(disposition: AssetDisposition): void {
    const snapshot: DecisionSnapshot = {
      v: DECISIONS_VERSION,
      network: "testnet",
      source: SOURCE,
      destination: null,
      memo: null,
      memoType: null,
      destinationAcknowledgedFor: null,
      assetDispositions: { [NOQ]: disposition },
      transferDestinations: {},
      claimableBalanceSelections: {},
      seen: { [NOQ]: "line:5.0000000" },
    };
    window.sessionStorage.setItem(KEY, JSON.stringify(snapshot));
  }

  beforeEach(() => {
    plan = unquotedPlan();
    stubFetch();
  });

  test("a restored convert whose quote is gone is asked again, not kept", async () => {
    restoring("convert");
    await analyzed();
    expect(useDemolishStore.getState().assetDispositions).toEqual({});
    expect(reasons()).toContain(NAMED);
    expect(proceedButton().disabled).toBe(true);
  });

  test("a restored convert that still has its quote is kept", async () => {
    plan = unquotedPlan(QUOTE);
    restoring("convert");
    await analyzed();
    expect(useDemolishStore.getState().assetDispositions).toEqual({ [NOQ]: "convert" });
    expect(reasons()).not.toContain(NAMED);
  });

  test("a restored answer other than convert is kept with no quote", async () => {
    restoring("issuer");
    await analyzed();
    expect(useDemolishStore.getState().assetDispositions).toEqual({ [NOQ]: "issuer" });
    expect(reasons()).not.toContain(NAMED);
  });

  test("the answer asked for on analyze is the one the review accepts, so the trip ends", async () => {
    restoring("convert");
    await analyzed();
    expect(reasons()).toContain(NAMED);

    // The one answer the card offers that a close can act on.
    await click(screen.getByRole("radio", { name: /^Send my 5\.0000000 NOQ to another account/ }));
    await type(screen.getByRole("textbox", { name: /Destination account for NOQ/ }), PAYEE);
    await type(screen.getByRole("textbox", { name: /Destination address/ }), DEST);
    await click(screen.getByLabelText(/This is a wallet I control/));
    expect(reasons()).toEqual([]);

    await click(proceedButton());
    await waitFor(() => expect(useDemolishStore.getState().phase).toBe("PREFLIGHT_COMPLETE"));
    expect(useDemolishStore.getState().planSignature?.unflooredConverts).toEqual([]);

    // The confirm-time refresh of the same plan: the floor check that used to send the user
    // back to analyze now passes.
    const outcome = await refreshReviewedPlan("testnet");
    expect(outcome).toEqual({ kind: "unchanged" });
  });

  test("the review still refuses a convert with no floor, so analyze is what keeps it out", async () => {
    restoring("convert");
    await analyzed();
    await click(screen.getByRole("radio", { name: /^Send my 5\.0000000 NOQ to another account/ }));
    await type(screen.getByRole("textbox", { name: /Destination account for NOQ/ }), PAYEE);
    await type(screen.getByRole("textbox", { name: /Destination address/ }), DEST);
    await click(screen.getByLabelText(/This is a wallet I control/));
    await click(proceedButton());
    await waitFor(() => expect(useDemolishStore.getState().phase).toBe("PREFLIGHT_COMPLETE"));

    // The state analyze no longer lets through, forced into the store behind the review.
    act(() => useDemolishStore.getState().setAssetDisposition(NOQ, "convert"));
    const signature = signatureOf(plan, account(), useDemolishStore.getState());
    useDemolishStore.setState({ planSignature: signature });
    expect(await refreshReviewedPlan("testnet")).toEqual({
      kind: "needs-analyze",
      message: PLAN_FLOOR_MISSING,
    });
  });
});
