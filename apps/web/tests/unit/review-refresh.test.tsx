import { afterEach, beforeEach, expect, jest, mock, spyOn, test } from "bun:test";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";
import * as navigation from "next/navigation";
import ReviewView, { PREPARED_TICK_MS } from "@/components/review/ReviewView";
import * as analyzeClient from "@/lib/api/analyze-client";
import * as closeClient from "@/lib/api/close-client";
import * as closeRecord from "@/lib/session/close-record";
import * as recovery from "@/lib/session/recovery";
import {
  ApiRequestError,
  PLAN_FEES_UNREADABLE,
  PLAN_FLOOR_MISSING,
  PLAN_HOLDINGS_CHANGED,
  PLAN_NOT_COMPARABLE,
  PLAN_REFRESH_FAILED,
  PLAN_REFRESH_UNUSABLE,
  PLAN_REVIEW_LEFT,
} from "@/lib/utils/user-error";
import { useDemolishStore } from "@/store/demolish";
import { useNetworkStore } from "@/store/network";
import type { AccountState } from "@/types/account";
import type { PlannedStep } from "@/types/plan";
import { freshAccount, freshPlan, stubUnchangedRefresh } from "./fixtures/fresh-plan";

const SOURCE = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const REVIEWED_HASH = "a".repeat(64);
const FRESH_HASH = "b".repeat(64);

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

let pushed: string[] = [];

function seed(): void {
  useDemolishStore.getState().reset();
  useDemolishStore.getState().setAddresses(SOURCE, DEST);
  useDemolishStore.getState().setPlan([STEP], REVIEWED_HASH, 1);
  useDemolishStore.getState().setPhase("PREFLIGHT_COMPLETE");
  useDemolishStore.getState().setAccountState(freshAccount(SOURCE));
}

/** The plan was reviewed from the fixture account; the refresh reads `account` and `plan`. */
function refreshReads(account: AccountState, plan = freshPlan([STEP], { planHash: FRESH_HASH })) {
  stubUnchangedRefresh(freshAccount(SOURCE), freshPlan([STEP], { planHash: REVIEWED_HASH }));
  spyOn(analyzeClient, "readAccount").mockResolvedValue(account);
  return spyOn(closeClient, "fetchClosePlan").mockResolvedValue(plan);
}

async function show() {
  await act(async () => {
    render(<ReviewView network="testnet" />);
  });
}

function checkbox(): HTMLInputElement {
  return screen.getByRole("checkbox") as HTMLInputElement;
}

function continueButton(): HTMLButtonElement {
  return screen.getByRole("button", {
    name: /continue to signing|preparing/i,
  }) as HTMLButtonElement;
}

async function confirm() {
  fireEvent.click(checkbox());
  await act(async () => {
    fireEvent.click(continueButton());
  });
}

beforeEach(() => {
  pushed = [];
  useNetworkStore.setState({ network: "testnet" });
  seed();
  spyOn(navigation, "useRouter").mockImplementation(
    () =>
      ({
        push: (path: string) => pushed.push(path),
        replace: () => {},
      }) as unknown as ReturnType<typeof navigation.useRouter>
  );
  spyOn(recovery, "readUnresolved").mockResolvedValue(null);
  spyOn(closeRecord, "saveCloseSession").mockResolvedValue("s");
});

afterEach(() => {
  jest.useRealTimers();
  mock.restore();
});

test("the prepared line says how old the plan is and keeps up while the page is open", async () => {
  const start = Date.now();
  jest.useFakeTimers();
  useDemolishStore.setState({ planPreparedAt: start - 3 * 60_000 });
  const clock = spyOn(Date, "now").mockReturnValue(start);
  await show();
  expect(screen.getByTestId("plan-prepared").textContent).toBe("Plan prepared 3 min ago");

  clock.mockReturnValue(start + 60_000);
  await act(async () => {
    jest.advanceTimersByTime(PREPARED_TICK_MS);
  });
  expect(screen.getByTestId("plan-prepared").textContent).toBe("Plan prepared 4 min ago");
});

test("refreshing a plan that did not change says so and keeps the consent", async () => {
  refreshReads(freshAccount(SOURCE));
  await show();
  fireEvent.click(checkbox());

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Refresh plan" }));
  });

  expect(screen.getByText("The plan is the same as the one you reviewed.")).toBeDefined();
  expect(checkbox().checked).toBe(true);
  expect(useDemolishStore.getState().planHash).toBe(FRESH_HASH);
});

test("refreshing a plan that changed lists what changed and asks for the consent again", async () => {
  refreshReads(freshAccount(SOURCE, { nativeBalanceLumens: "20.0000000" }));
  await show();
  fireEvent.click(checkbox());

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Refresh plan" }));
  });

  const changes = screen.getByTestId("plan-changes");
  expect(changes.textContent).toContain("The plan changed since you reviewed it");
  expect(changes.textContent).toContain("The least you will receive is now about 19.99999 XLM");
  expect(checkbox().checked).toBe(false);
  expect(continueButton().disabled).toBe(true);
  // The fresh plan is the one on screen now, and the one the consent will be about.
  expect(useDemolishStore.getState().accountState?.nativeBalanceLumens).toBe("20.0000000");
  expect(useDemolishStore.getState().planHash).toBe(FRESH_HASH);
});

test("a confirm whose fresh plan is unchanged moves on with the fresh hash", async () => {
  const fetchPlan = refreshReads(freshAccount(SOURCE));
  await show();

  await confirm();

  expect(fetchPlan).toHaveBeenCalledTimes(1);
  expect(fetchPlan.mock.calls[0]![0]).toMatchObject({ source: SOURCE, destination: DEST });
  expect(useDemolishStore.getState().planHash).toBe(FRESH_HASH);
  expect(useDemolishStore.getState().phase).toBe("STEP_EXECUTING");
  expect(pushed).toEqual(["/testnet/execute"]);
});

test("a confirm whose fresh plan changed does not move on and asks for the consent again", async () => {
  const save = spyOn(closeRecord, "saveCloseSession").mockResolvedValue("s");
  refreshReads(
    freshAccount(SOURCE),
    freshPlan([STEP, { ...STEP, index: 1, type: "CANCEL_OFFERS" }])
  );
  await show();

  await confirm();

  expect(screen.getByTestId("plan-changes").textContent).toContain(
    "The plan now has 2 steps instead of 1."
  );
  expect(checkbox().checked).toBe(false);
  expect(save).not.toHaveBeenCalled();
  expect(useDemolishStore.getState().phase).toBe("PREFLIGHT_COMPLETE");
  expect(pushed).toEqual([]);
});

test("a step fee the user did not see is a change, never signed silently", async () => {
  const save = spyOn(closeRecord, "saveCloseSession").mockResolvedValue("s");
  refreshReads(freshAccount(SOURCE), freshPlan([{ ...STEP, estimatedFeeLumens: "0.0000200" }]));
  await show();

  await confirm();

  expect(screen.getByTestId("plan-changes").textContent).toContain(
    "The steps of the plan or their network fees changed."
  );
  expect(save).not.toHaveBeenCalled();
  expect(useDemolishStore.getState().phase).toBe("PREFLIGHT_COMPLETE");
});

test("a confirm whose fetch fails says so, does not move on, and can be tried again", async () => {
  const save = spyOn(closeRecord, "saveCloseSession").mockResolvedValue("s");
  stubUnchangedRefresh(freshAccount(SOURCE), freshPlan([STEP], { planHash: REVIEWED_HASH }));
  const read = spyOn(analyzeClient, "readAccount").mockRejectedValueOnce(new Error("offline"));
  await show();

  await confirm();

  expect(screen.getByText(PLAN_REFRESH_FAILED)).toBeDefined();
  expect(save).not.toHaveBeenCalled();
  expect(useDemolishStore.getState().phase).toBe("PREFLIGHT_COMPLETE");
  expect(useDemolishStore.getState().planHash).toBe(REVIEWED_HASH);
  expect(pushed).toEqual([]);

  read.mockResolvedValue(freshAccount(SOURCE));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  });

  expect(save).toHaveBeenCalledTimes(1);
  expect(useDemolishStore.getState().phase).toBe("STEP_EXECUTING");
});

test("a confirm whose account holds something new sends the user back to decide", async () => {
  const save = spyOn(closeRecord, "saveCloseSession").mockResolvedValue("s");
  refreshReads(
    freshAccount(SOURCE, {
      trustlines: [{ asset: `USDC:${DEST}`, balance: "1" }] as never,
    })
  );
  await show();

  await confirm();

  expect(screen.getByText(PLAN_HOLDINGS_CHANGED)).toBeDefined();
  expect(save).not.toHaveBeenCalled();
  // Nothing of the fresh read is installed: its answers would not match the account.
  expect(useDemolishStore.getState().planHash).toBe(REVIEWED_HASH);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Go back to decide" }));
  });
  expect(pushed).toEqual(["/testnet/analyze"]);
  expect(useDemolishStore.getState().phase).toBe("PREFLIGHT_COMPLETE");
});

test("a fresh plan that needs an answer is not consented to here", async () => {
  refreshReads(freshAccount(SOURCE), freshPlan([STEP], { status: "needs_decisions" }));
  await show();

  await confirm();

  expect(screen.getByRole("button", { name: "Go back to decide" })).toBeDefined();
  expect(useDemolishStore.getState().phase).toBe("PREFLIGHT_COMPLETE");
});

test("while the confirm checks the plan, the consent and the button are held and a second click does nothing", async () => {
  const save = spyOn(closeRecord, "saveCloseSession").mockResolvedValue("s");
  stubUnchangedRefresh(freshAccount(SOURCE), freshPlan([STEP], { planHash: REVIEWED_HASH }));
  let answer!: (account: AccountState) => void;
  const read = spyOn(analyzeClient, "readAccount").mockImplementation(
    () => new Promise<AccountState>((resolve) => (answer = resolve))
  );
  await show();
  fireEvent.click(checkbox());

  await act(async () => {
    fireEvent.click(continueButton());
  });
  expect(checkbox().disabled).toBe(true);
  expect(continueButton().disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Refresh plan" }) as HTMLButtonElement).disabled).toBe(
    true
  );

  // A click on the box is refused, and a second confirm or refresh starts nothing.
  fireEvent.click(checkbox());
  expect(checkbox().checked).toBe(true);
  await act(async () => {
    fireEvent.click(continueButton());
    fireEvent.click(screen.getByRole("button", { name: "Refresh plan" }));
  });
  expect(read).toHaveBeenCalledTimes(1);

  await act(async () => {
    answer(freshAccount(SOURCE));
  });

  expect(read).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledTimes(1);
  expect(useDemolishStore.getState().phase).toBe("STEP_EXECUTING");
});

test("a swap with no recorded minimum sends the user back to decide, on every confirm", async () => {
  const save = spyOn(closeRecord, "saveCloseSession").mockResolvedValue("s");
  const usdc = `USDC:${DEST}`;
  const holding = freshAccount(SOURCE, { trustlines: [{ asset: usdc, balance: "5" }] as never });
  useDemolishStore.getState().setAccountState(holding);
  useDemolishStore.setState({
    assetDispositions: { [usdc]: "convert" },
    classicConversionFloors: {},
  });
  const { fetchClosePlan } = stubUnchangedRefresh(holding, freshPlan([STEP]));
  await show();

  for (const attempt of [1, 2]) {
    if (!checkbox().checked) fireEvent.click(checkbox());
    await act(async () => {
      fireEvent.click(continueButton());
    });
    expect(fetchClosePlan).toHaveBeenCalledTimes(attempt);
    expect(screen.getByText(PLAN_FLOOR_MISSING)).toBeDefined();
    expect(screen.getByRole("button", { name: "Go back to decide" })).toBeDefined();
    // Not a change to consent to again: the consent stands and nothing new is installed.
    expect(screen.queryByTestId("plan-changes")).toBeNull();
    expect(checkbox().checked).toBe(true);
  }
  expect(save).not.toHaveBeenCalled();
  expect(useDemolishStore.getState().phase).toBe("PREFLIGHT_COMPLETE");
  expect(useDemolishStore.getState().planHash).toBe(REVIEWED_HASH);
  expect(pushed).toEqual([]);
});

test("a fresh plan whose fees cannot be read keeps the reviewed one, on every confirm", async () => {
  const save = spyOn(closeRecord, "saveCloseSession").mockResolvedValue("s");
  const fetchPlan = refreshReads(
    freshAccount(SOURCE),
    freshPlan([{ ...STEP, estimatedFeeLumens: "unknown" }], { planHash: FRESH_HASH })
  );
  await show();

  await confirm();
  expect(screen.getByText(PLAN_FEES_UNREADABLE)).toBeDefined();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  });

  expect(fetchPlan).toHaveBeenCalledTimes(2);
  expect(screen.getByText(PLAN_FEES_UNREADABLE)).toBeDefined();
  expect(screen.queryByTestId("plan-changes")).toBeNull();
  expect(checkbox().checked).toBe(true);
  expect(save).not.toHaveBeenCalled();
  expect(useDemolishStore.getState().phase).toBe("PREFLIGHT_COMPLETE");
  expect(useDemolishStore.getState().planHash).toBe(REVIEWED_HASH);
  expect(useDemolishStore.getState().executionPlan[0]?.estimatedFeeLumens).toBe("0.0000100");
});

test("a changed plan's figure is held to the stored floor, not to a quote that rose", async () => {
  const usdc = `USDC:${DEST}`;
  const holding = freshAccount(SOURCE, { trustlines: [{ asset: usdc, balance: "5" }] as never });
  useDemolishStore.getState().setAccountState(holding);
  useDemolishStore.setState({
    assetDispositions: { [usdc]: "convert" },
    classicConversionFloors: { [usdc]: { minAmountOut: "30000000" } },
  });
  stubUnchangedRefresh(holding, freshPlan([STEP]));
  const risen = freshPlan([STEP, { ...STEP, index: 1, type: "CANCEL_OFFERS" }], {
    decisionPoints: [
      {
        id: `asset:${usdc}`,
        type: "asset_disposition",
        subject: {
          asset: usdc,
          balance: "5",
          quote: { estimatedReceive: "90000000", minAmountOut: "80000000" },
        },
        options: [{ id: "convert_to_xlm" }],
        default: "convert_to_xlm",
        required: true,
      },
    ],
  } as never);
  spyOn(closeClient, "fetchClosePlan").mockResolvedValue(risen);
  await show();

  await confirm();

  expect(screen.getByTestId("plan-changes")).toBeDefined();
  expect(useDemolishStore.getState().expectedReceive?.swapStroops).toBe("30000000");
});

test("two clicks in the same moment, before the page has re-rendered, start one confirm", async () => {
  const save = spyOn(closeRecord, "saveCloseSession").mockResolvedValue("s");
  const { readAccount: read } = stubUnchangedRefresh(freshAccount(SOURCE), freshPlan([STEP]));
  await show();
  fireEvent.click(checkbox());

  await act(async () => {
    const button = continueButton();
    fireEvent.click(button);
    fireEvent.click(button);
  });

  expect(read).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledTimes(1);
  expect(pushed).toEqual(["/testnet/execute"]);
});

test("while a manual refresh runs, the consent and the button are held", async () => {
  stubUnchangedRefresh(freshAccount(SOURCE), freshPlan([STEP]));
  let answer!: (account: AccountState) => void;
  spyOn(analyzeClient, "readAccount").mockImplementation(
    () => new Promise<AccountState>((resolve) => (answer = resolve))
  );
  await show();
  fireEvent.click(checkbox());

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Refresh plan" }));
  });
  expect(checkbox().disabled).toBe(true);
  expect(continueButton().disabled).toBe(true);

  await act(async () => {
    answer(freshAccount(SOURCE));
  });
  expect(checkbox().disabled).toBe(false);
  expect(continueButton().disabled).toBe(false);
});

test("a retry after a failed confirm does not start the close once the box is unticked", async () => {
  const save = spyOn(closeRecord, "saveCloseSession").mockResolvedValue("s");
  stubUnchangedRefresh(freshAccount(SOURCE), freshPlan([STEP]));
  spyOn(analyzeClient, "readAccount").mockRejectedValueOnce(new Error("offline"));
  await show();

  await confirm();
  expect(screen.getByText(PLAN_REFRESH_FAILED)).toBeDefined();
  fireEvent.click(checkbox());
  expect(checkbox().checked).toBe(false);

  const retry = screen.getByRole("button", { name: "Try again" }) as HTMLButtonElement;
  expect(retry.disabled).toBe(true);
  await act(async () => {
    fireEvent.click(retry);
  });

  expect(save).not.toHaveBeenCalled();
  expect(useDemolishStore.getState().phase).toBe("PREFLIGHT_COMPLETE");
  expect(pushed).toEqual([]);
});

test("a plan installed without a reviewed signature is never consented to here", async () => {
  const save = spyOn(closeRecord, "saveCloseSession").mockResolvedValue("s");
  refreshReads(freshAccount(SOURCE));
  useDemolishStore.setState({ planSignature: null });
  await show();

  await confirm();

  expect(screen.getByText(PLAN_NOT_COMPARABLE)).toBeDefined();
  expect(screen.getByRole("button", { name: "Go back to decide" })).toBeDefined();
  expect(save).not.toHaveBeenCalled();
  expect(useDemolishStore.getState().planHash).toBe(REVIEWED_HASH);
});

/** A confirm whose account read waits until `answer` is called. */
function pendingRead() {
  stubUnchangedRefresh(freshAccount(SOURCE), freshPlan([STEP], { planHash: FRESH_HASH }));
  let answer!: (account: AccountState) => void;
  const read = spyOn(analyzeClient, "readAccount").mockImplementation(
    () => new Promise<AccountState>((resolve) => (answer = resolve))
  );
  return { read, answer: () => answer(freshAccount(SOURCE)) };
}

test("an answer changed while the confirm was in flight stops it: it answers a review no longer on screen", async () => {
  const save = spyOn(closeRecord, "saveCloseSession").mockResolvedValue("s");
  const { answer } = pendingRead();
  await show();
  await confirm();

  // Back to /analyze keeps the phase, and an answer there leaves the signature as it was.
  await act(async () => {
    useDemolishStore.getState().acknowledgeDefiPositions(SOURCE);
  });
  await act(async () => answer());

  expect(screen.getByText(PLAN_REVIEW_LEFT)).toBeDefined();
  expect(save).not.toHaveBeenCalled();
  expect(useDemolishStore.getState().phase).toBe("PREFLIGHT_COMPLETE");
  expect(useDemolishStore.getState().planHash).toBe(REVIEWED_HASH);
});

test("a close started again in this tab while the confirm was in flight stops it", async () => {
  const save = spyOn(closeRecord, "saveCloseSession").mockResolvedValue("s");
  const { answer } = pendingRead();
  await show();
  await confirm();

  // The same account, plan and answers, but another close of this tab.
  await act(async () => {
    const kept = useDemolishStore.getState();
    const { planSignature, executionPlan, planHash, accountState } = kept;
    kept.reset();
    useDemolishStore.getState().setAddresses(SOURCE, DEST);
    useDemolishStore.setState({
      phase: "PREFLIGHT_COMPLETE",
      planSignature,
      executionPlan,
      planHash,
      accountState,
    });
  });
  await act(async () => answer());

  expect(screen.getByText(PLAN_REVIEW_LEFT)).toBeDefined();
  expect(save).not.toHaveBeenCalled();
  expect(useDemolishStore.getState().phase).toBe("PREFLIGHT_COMPLETE");
});

test("leaving the review while the plan is fetched aborts it and checks nothing more", async () => {
  const unresolved = spyOn(recovery, "readUnresolved").mockResolvedValue(null);
  const save = spyOn(closeRecord, "saveCloseSession").mockResolvedValue("s");
  const { read, answer } = pendingRead();
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<ReviewView network="testnet" />);
  });
  await confirm();
  const signal = read.mock.calls[0]![2] as AbortSignal;
  expect(signal.aborted).toBe(false);

  view.unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => answer());

  expect(unresolved).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
  expect(useDemolishStore.getState().phase).toBe("PREFLIGHT_COMPLETE");
});

test("leaving the review while the saved state is read saves nothing", async () => {
  let found!: (value: null) => void;
  spyOn(recovery, "readUnresolved").mockImplementation(
    () => new Promise<null>((resolve) => (found = resolve)) as never
  );
  const save = spyOn(closeRecord, "saveCloseSession").mockResolvedValue("s");
  refreshReads(freshAccount(SOURCE));
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<ReviewView network="testnet" />);
  });
  await confirm();

  view.unmount();
  await act(async () => found(null));

  expect(save).not.toHaveBeenCalled();
  expect(useDemolishStore.getState().phase).toBe("PREFLIGHT_COMPLETE");
});

test("leaving the review while the close is saved does not move on to signing", async () => {
  let saved!: (id: string) => void;
  spyOn(closeRecord, "saveCloseSession").mockImplementation(
    () => new Promise<string>((resolve) => (saved = resolve)) as never
  );
  refreshReads(freshAccount(SOURCE));
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<ReviewView network="testnet" />);
  });
  await confirm();

  view.unmount();
  await act(async () => saved("s"));

  expect(useDemolishStore.getState().phase).toBe("PREFLIGHT_COMPLETE");
  expect(pushed).toEqual([]);
});

test("a return to issuer whose balance grew is a change to consent to again", async () => {
  const usdc = `USDC:${DEST}`;
  const holding = (balance: string) =>
    freshAccount(SOURCE, { trustlines: [{ asset: usdc, balance }] as never });
  useDemolishStore.getState().setAccountState(holding("10.0000000"));
  useDemolishStore.setState({ assetDispositions: { [usdc]: "issuer" } });
  stubUnchangedRefresh(holding("10.0000000"), freshPlan([STEP]));
  spyOn(analyzeClient, "readAccount").mockResolvedValue(holding("10000.0000000"));
  await show();

  await confirm();

  expect(screen.getByTestId("plan-changes").textContent).toContain(
    "The amount of an asset or a claimable balance on the account changed."
  );
  expect(checkbox().checked).toBe(false);
  expect(useDemolishStore.getState().accountState?.trustlines[0]?.balance).toBe("10000.0000000");
  expect(useDemolishStore.getState().phase).toBe("PREFLIGHT_COMPLETE");
});

test("a token balance that changed is a change to consent to again", async () => {
  const token = "C" + "B".repeat(55);
  const holding = (balance: string) =>
    freshAccount(SOURCE, {
      sorobanTokens: { tokens: [{ contract: token, balance }] } as never,
    });
  useDemolishStore.getState().setAccountState(holding("100"));
  stubUnchangedRefresh(holding("100"), freshPlan([STEP]));
  spyOn(analyzeClient, "readAccount").mockResolvedValue(holding("5000"));
  await show();

  await confirm();

  expect(screen.getByTestId("plan-changes").textContent).toContain(
    "The amount of an asset or a claimable balance on the account changed."
  );
  expect(checkbox().checked).toBe(false);
});

test("an added signer is a change to consent to again", async () => {
  refreshReads(
    freshAccount(SOURCE, {
      signers: [{ key: Keypair.random().publicKey(), weight: 1, type: "ed25519_public_key" }],
    })
  );
  await show();

  await confirm();

  expect(screen.getByTestId("plan-changes").textContent).toContain(
    "The account's signers, thresholds or sponsorships changed."
  );
  expect(checkbox().checked).toBe(false);
});

test("a fresh plan of an unexpected shape is a failed refresh, and the button comes back", async () => {
  const save = spyOn(closeRecord, "saveCloseSession").mockResolvedValue("s");
  const malformed = freshPlan([STEP], { planHash: FRESH_HASH }) as unknown as Record<
    string,
    unknown
  >;
  delete malformed.decisionPoints;
  refreshReads(freshAccount(SOURCE), malformed as never);
  await show();

  await confirm();

  expect(screen.getByText(PLAN_REFRESH_UNUSABLE)).toBeDefined();
  expect(continueButton().disabled).toBe(false);
  expect(screen.queryByText("Preparing...")).toBeNull();
  expect(save).not.toHaveBeenCalled();
  expect(useDemolishStore.getState().planHash).toBe(REVIEWED_HASH);
});

test.each([
  ["missing", undefined],
  ["not a 64-character hex hash", "abc"],
])("a fresh plan hash that is %s is never installed", async (_case, planHash) => {
  const save = spyOn(closeRecord, "saveCloseSession").mockResolvedValue("s");
  refreshReads(freshAccount(SOURCE), freshPlan([STEP], { planHash } as never));
  await show();

  await confirm();

  expect(screen.getByText(PLAN_REFRESH_UNUSABLE)).toBeDefined();
  expect(save).not.toHaveBeenCalled();
  expect(useDemolishStore.getState().planHash).toBe(REVIEWED_HASH);
});

const BUSY = new ApiRequestError(
  503,
  "The data provider is busy right now. Try again in a moment.",
  undefined,
  "service_unavailable",
  30
);

test.each([
  ["account read", "readAccount"],
  ["plan", "fetchClosePlan"],
] as const)(
  "a busy provider on the %s says so, not the connection, and the close can be tried again",
  async (_case, failing) => {
    const save = spyOn(closeRecord, "saveCloseSession").mockResolvedValue("s");
    const stubs = stubUnchangedRefresh(
      freshAccount(SOURCE),
      freshPlan([STEP], { planHash: REVIEWED_HASH })
    );
    stubs[failing].mockRejectedValueOnce(BUSY);
    await show();

    await confirm();

    const alert = screen.getByText(/busy or not answering/).textContent ?? "";
    expect(alert).toContain("signing has not started");
    expect(alert).toContain("Try again in about 30 seconds.");
    expect(alert).not.toMatch(/check your connection/i);
    expect(save).not.toHaveBeenCalled();
    expect(useDemolishStore.getState().planHash).toBe(REVIEWED_HASH);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(useDemolishStore.getState().phase).toBe("STEP_EXECUTING");
  }
);

test("an answer from the service that is not a busy one keeps the connection out of it", async () => {
  stubUnchangedRefresh(freshAccount(SOURCE), freshPlan([STEP], { planHash: REVIEWED_HASH }));
  spyOn(closeClient, "fetchClosePlan").mockRejectedValueOnce(new ApiRequestError(500, ""));
  await show();

  await confirm();

  expect(screen.getByText(PLAN_REFRESH_UNUSABLE)).toBeDefined();
  expect(useDemolishStore.getState().phase).toBe("PREFLIGHT_COMPLETE");
});

test("the account and the plan are asked for at once", async () => {
  stubUnchangedRefresh(freshAccount(SOURCE), freshPlan([STEP], { planHash: REVIEWED_HASH }));
  spyOn(analyzeClient, "readAccount").mockImplementation(() => new Promise<AccountState>(() => {}));
  const plan = spyOn(closeClient, "fetchClosePlan").mockImplementation(() => new Promise(() => {}));
  await show();

  await confirm();

  expect(plan).toHaveBeenCalledTimes(1);
});

const TOKEN = "C" + "D".repeat(55);
const holdingToken = (overrides: Partial<AccountState> = {}) =>
  freshAccount(SOURCE, {
    sorobanTokens: { tokens: [{ contract: TOKEN, balance: "1" }] } as never,
    ...overrides,
  });

function plannedTokens(plan: ReturnType<typeof spyOn>): unknown[] {
  const body = plan.mock.calls[0]![0] as { decisions: { id: string }[] };
  return body.decisions.filter((d) => d.id.startsWith("token:")).map((d) => d.id);
}

test("the plan is asked for with the tokens of the account that was reviewed", async () => {
  useDemolishStore.getState().setAccountState(holdingToken());
  const { fetchClosePlan: plan } = stubUnchangedRefresh(
    holdingToken(),
    freshPlan([STEP], { planHash: REVIEWED_HASH })
  );
  await show();

  await confirm();

  expect(plannedTokens(plan)).toEqual([`token:${TOKEN}`]);
  expect(useDemolishStore.getState().phase).toBe("STEP_EXECUTING");
});

test("a token the fresh read finds that the review did not hold is never installed", async () => {
  const save = spyOn(closeRecord, "saveCloseSession").mockResolvedValue("s");
  const plan = refreshReads(holdingToken());
  await show();

  await confirm();

  expect(plannedTokens(plan)).toEqual([]);
  expect(screen.getByText(PLAN_HOLDINGS_CHANGED)).toBeDefined();
  expect(save).not.toHaveBeenCalled();
  expect(useDemolishStore.getState().planHash).toBe(REVIEWED_HASH);
});
