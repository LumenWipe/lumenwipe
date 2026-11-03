import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Suspense } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";
import * as navigation from "next/navigation";
import AnalyzePage from "@/app/[network]/analyze/page";
import CompletePage from "@/app/[network]/complete/page";
import ExecutePage from "@/app/[network]/execute/page";
import HomePage from "@/app/[network]/page";
import ReviewPage from "@/app/[network]/review/page";
import * as sessionRecovery from "@/hooks/useSessionRecovery";
import * as snapshots from "@/lib/session/decision-snapshot";
import {
  DECISIONS_VERSION,
  OTHER_ACCOUNT,
  OTHER_VERSION,
  UNREADABLE,
  type DecisionSnapshot,
} from "@/lib/session/decision-snapshot";
import { useDemolishStore } from "@/store/demolish";
import ReviewView from "@/components/review/ReviewView";
import * as closeRecord from "@/lib/session/close-record";
import * as recovery from "@/lib/session/recovery";
import { keepDecisions, keepDestinationDraft } from "@/lib/session/restore-decisions";
import { useNetworkStore } from "@/store/network";
import type { AccountState } from "@/types/account";
import type { PlannedStep } from "@/types/plan";
import type { SessionRecord } from "@/types/session";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";

const SOURCE = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const OTHER_DEST = Keypair.random().publicKey();
const PAYEE = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const USDC = `USDC:${ISSUER}`;
const AQUA = `AQUA:${ISSUER}`;
const GONE = `GONE:${ISSUER}`;
const BALANCE = "00000000b1";
const KEY = `lumenwipe:decisions:testnet:${SOURCE}`;
const params = Object.assign(Promise.resolve({ network: "testnet" as const }), {
  status: "fulfilled",
  value: { network: "testnet" as const },
});

function trustline(asset: string, balance: string) {
  return { asset, balance, limit: "1000", buyingLiabilities: "0", sellingLiabilities: "0" };
}

function account(usdc = "5.0000000"): AccountState {
  return {
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
    trustlines: [trustline(USDC, usdc), trustline(AQUA, "3.0000000")],
    openOffers: [],
    poolShares: [],
    claimableBalances: [
      { id: BALANCE, asset: "native", amount: "1.0000000", claimants: [], sponsor: null },
    ],
    subEntryMismatch: false,
    defiPositions: emptyDefiPositionsResult(SOURCE),
    defiPositionsWarnings: [],
  } as unknown as AccountState;
}

const planBody = { status: "ready", blockers: [], steps: [], decisionPoints: [] };

function snapshot(over: Partial<DecisionSnapshot> = {}): DecisionSnapshot {
  return {
    v: DECISIONS_VERSION,
    network: "testnet",
    source: SOURCE,
    destination: DEST,
    memo: null,
    memoType: null,
    destinationAcknowledgedFor: DEST,
    assetDispositions: { [USDC]: "transfer", [AQUA]: "issuer", [GONE]: "convert" },
    transferDestinations: { [USDC]: PAYEE },
    claimableBalanceSelections: { [BALANCE]: "forfeit" },
    seen: { [USDC]: "line:5.0000000", [AQUA]: "line:3.0000000", [GONE]: "line:1.0000000" },
    ...over,
  };
}

let replace: ReturnType<typeof mock>;
let accountRead: () => Promise<Response>;
let fresh: ReturnType<typeof useDemolishStore.getState>;
let restoreStorage: () => unknown = () => {};

function stubFetch(): void {
  spyOn(globalThis, "fetch").mockImplementation((async (input: unknown) => {
    const url = String(input);
    if (url.includes("/close/plan")) return Response.json(planBody);
    if (url.includes("/account/")) return accountRead();
    return Response.json({});
  }) as unknown as typeof fetch);
}

/** What a reload leaves: a store as the page first builds it, and this tab's storage. */
function reload(): void {
  cleanup();
  useDemolishStore.setState(fresh, true);
}

async function mount(ui: React.ReactElement): Promise<void> {
  await act(async () => {
    render(ui);
  });
}

async function analyzed(): Promise<void> {
  await mount(<AnalyzePage params={params} />);
  await waitFor(() => expect(screen.getByText("Account analyzed")).toBeTruthy());
}

beforeEach(() => {
  window.sessionStorage.clear();
  useDemolishStore.getState().reset();
  fresh = useDemolishStore.getState();
  useNetworkStore.setState({ network: "testnet" });
  accountRead = async () => Response.json(account());
  replace = mock(() => {});
  const router = { push: () => {}, replace };
  spyOn(navigation, "useRouter").mockImplementation(() => router as never);
  spyOn(navigation, "useSearchParams").mockImplementation(
    () => new URLSearchParams(`source=${SOURCE}`) as never
  );
  stubFetch();
});

afterEach(() => {
  cleanup();
  mock.restore();
  restoreStorage();
  restoreStorage = () => {};
  window.sessionStorage.clear();
});

describe("a reload keeps the user's choices", () => {
  test("choices made on analyze are back after a reload with a fresh store", async () => {
    await analyzed();
    const store = useDemolishStore.getState();
    act(() => {
      store.setAssetDisposition(USDC, "transfer");
      store.setTransferDestination(USDC, PAYEE);
      store.setAssetDisposition(AQUA, "issuer");
      store.setClaimableBalanceSelection(BALANCE, "forfeit");
      store.acknowledgeDestination(DEST);
    });

    reload();
    expect(useDemolishStore.getState().assetDispositions).toEqual({});
    await analyzed();

    const restored = useDemolishStore.getState();
    expect(restored.assetDispositions).toEqual({ [USDC]: "transfer", [AQUA]: "issuer" });
    expect(restored.transferDestinations).toEqual({ [USDC]: PAYEE });
    expect(restored.claimableBalanceSelections).toEqual({ [BALANCE]: "forfeit" });
    expect(restored.destinationAcknowledgedFor).toBeNull();
    expect(screen.getByText(/earlier choices for this account were kept in this tab/)).toBeTruthy();
  });

  test("the destination typed on analyze is back in its field after a reload", async () => {
    const bare = { ...account(), trustlines: [], numSubEntries: 0 };
    accountRead = async () => Response.json(bare);
    await analyzed();
    const field = await screen.findByLabelText(/Destination address/);
    fireEvent.change(field, { target: { value: DEST } });
    act(() => useDemolishStore.getState().acknowledgeDestination(DEST));

    reload();
    await analyzed();
    const restored = (await screen.findByLabelText(/Destination address/)) as HTMLInputElement;
    expect(restored.value).toBe(DEST);
    expect(useDemolishStore.getState().destinationAcknowledgedFor).toBe(DEST);
  });

  test("the saved value holds the user's answers and nothing of the plan or what was sent", async () => {
    await analyzed();
    const secret = Keypair.random().secret();
    const step: PlannedStep = {
      index: 0,
      type: "MERGE",
      title: "MERGE",
      description: "",
      operationCount: 1,
      estimatedFeeLumens: "0.0000100",
      txXdr: "AAAAplanxdr",
      status: "pending",
      txHash: null,
      error: null,
    };
    act(() => {
      useDemolishStore.getState().setAssetDisposition(USDC, "convert");
      useDemolishStore.setState({
        executionPlan: [step],
        planHash: "planhash0123",
        sessionId: "session-id",
        unconfirmedSubmission: {
          hash: "e".repeat(64),
          covers: ["MERGE"],
          validUntil: 5,
          signedXdr: "AAAAsignedenvelope",
          secret,
        } as never,
      });
    });

    const raw = window.sessionStorage.getItem(KEY) ?? "";
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(
      [
        "assetDispositions",
        "claimableBalanceSelections",
        "destination",
        "destinationAcknowledgedFor",
        "memo",
        "memoType",
        "network",
        "seen",
        "source",
        "transferDestinations",
        "v",
      ].sort()
    );
    for (const leaked of [
      "AAAAplanxdr",
      "planhash0123",
      "session-id",
      "e".repeat(64),
      "AAAAsignedenvelope",
      secret,
    ]) {
      expect(raw).not.toContain(leaked);
    }
  });

  test("a restored value cannot set the phase, plan, plan hash, session or a pending hash", async () => {
    window.sessionStorage.setItem(
      KEY,
      JSON.stringify({
        ...snapshot(),
        phase: "STEP_EXECUTING",
        planHash: "planhash0123",
        sessionId: "session-id",
        executionPlan: [{ index: 0, type: "MERGE", txXdr: "AAAAplanxdr" }],
        unconfirmed: { hash: "e".repeat(64), covers: ["MERGE"], validUntil: 5 },
        unconfirmedSubmission: { hash: "e".repeat(64), signedXdr: "AAAAxdr" },
      })
    );
    await analyzed();
    const state = useDemolishStore.getState();
    expect(state.phase).toBe("IDLE");
    expect(state.executionPlan).toEqual([]);
    expect(state.planHash).toBeNull();
    expect(state.sessionId).toBeNull();
    expect(state.unconfirmedSubmission).toBeNull();
    expect(state.assetDispositions[USDC]).toBe("transfer");
  });
});

describe("what is restored is checked against what it was given for", () => {
  test("an acknowledgement given for an edited destination is dropped before the read lands", async () => {
    let land: (r: Response) => void = () => {};
    accountRead = () => new Promise((resolve) => (land = resolve));
    window.sessionStorage.setItem(
      KEY,
      JSON.stringify(snapshot({ destination: OTHER_DEST, destinationAcknowledgedFor: DEST }))
    );
    await mount(<AnalyzePage params={params} />);

    const state = useDemolishStore.getState();
    expect(state.destinationAddress).toBe(OTHER_DEST);
    expect(state.destinationAcknowledgedFor).toBeNull();
    await act(async () => land(Response.json(account())));
  });

  test("a resumed close keeps its own destination, and an acknowledgement for another is dropped", async () => {
    useDemolishStore.getState().setAddresses(SOURCE, OTHER_DEST);
    window.sessionStorage.setItem(KEY, JSON.stringify(snapshot()));
    await analyzed();
    const state = useDemolishStore.getState();
    expect(state.destinationAddress).toBe(OTHER_DEST);
    expect(state.destinationAcknowledgedFor).toBeNull();
  });

  test("consent to leave positions or to the account's own checks is never restored", async () => {
    window.sessionStorage.setItem(
      KEY,
      JSON.stringify({
        ...snapshot(),
        defiPositionsAcknowledgedFor: SOURCE,
        issuerSupplyAcknowledgedFor: SOURCE,
        positionsLeftBehind: [`defi_leave:${SOURCE}:C1`],
      })
    );
    await analyzed();
    const state = useDemolishStore.getState();
    expect(state.defiPositionsAcknowledgedFor).toBeNull();
    expect(state.issuerSupplyAcknowledgedFor).toBeNull();
    expect(state.positionsLeftBehind).toEqual([]);
    expect(state.assetDispositions[AQUA]).toBe("issuer");
    expect(screen.getByText(/Confirmations that give value up are not kept/)).toBeTruthy();
  });

  test("the saved value never carries that consent", async () => {
    await analyzed();
    act(() => {
      const store = useDemolishStore.getState();
      store.acknowledgeDefiPositions(SOURCE);
      store.acknowledgeIssuerSupply(SOURCE);
      store.setPositionLeftBehind(`defi_leave:${SOURCE}:C1`, true);
    });
    const raw = window.sessionStorage.getItem(KEY) ?? "";
    expect(raw).not.toContain("defi_leave");
    expect(Object.keys(JSON.parse(raw))).not.toContain("defiPositionsAcknowledgedFor");
    expect(Object.keys(JSON.parse(raw))).not.toContain("issuerSupplyAcknowledgedFor");
  });

  test("an asset whose balance changed is asked again, and one that is gone is dropped", async () => {
    accountRead = async () => Response.json(account("7.0000000"));
    window.sessionStorage.setItem(KEY, JSON.stringify(snapshot()));
    await analyzed();
    const state = useDemolishStore.getState();
    expect(state.assetDispositions).toEqual({ [AQUA]: "issuer" });
    expect(state.transferDestinations).toEqual({});
    expect(
      screen.getByText(
        "These assets changed since you chose what to do with them, so they need an answer again: USDC."
      )
    ).toBeTruthy();
  });
});

describe("the destination and memo kept are the last ones the user gave", () => {
  const saved = (): DecisionSnapshot => JSON.parse(window.sessionStorage.getItem(KEY) ?? "null");

  test("a memo cleared after proceeding stays cleared across a reload", async () => {
    useDemolishStore.getState().setAddresses(SOURCE, DEST, "1234", "id");
    keepDecisions("testnet", SOURCE);
    expect(saved().memo).toBe("1234");
    keepDestinationDraft("testnet", SOURCE, DEST, "", null);
    act(() => useDemolishStore.getState().setAssetDisposition(USDC, "convert"));
    keepDecisions("testnet", SOURCE);
    expect(saved().memo).toBeNull();
    expect(saved().memoType).toBeNull();

    reload();
    await analyzed();
    expect(useDemolishStore.getState().memo).toBeNull();
  });

  test("a destination typed after proceeding wins, and the one proceeded with wins on review", async () => {
    useDemolishStore.getState().setAddresses(SOURCE, DEST);
    keepDecisions("testnet", SOURCE);
    keepDestinationDraft("testnet", SOURCE, OTHER_DEST, "", null);
    keepDecisions("testnet", SOURCE);
    expect(saved().destination).toBe(OTHER_DEST);

    reload();
    await analyzed();
    expect(useDemolishStore.getState().destinationAddress).toBe(OTHER_DEST);

    act(() => {
      useDemolishStore.getState().setAddresses(SOURCE, OTHER_DEST);
      useDemolishStore.setState({ phase: "PREFLIGHT_COMPLETE" });
    });
    reload();
    await mount(<ReviewPage params={params} />);
    expect(replace).toHaveBeenCalledWith(`/testnet/analyze?source=${encodeURIComponent(SOURCE)}`);
    cleanup();
    await analyzed();
    expect(useDemolishStore.getState().destinationAddress).toBe(OTHER_DEST);
  });

  test("a half-typed destination is kept as none and every other choice still restores", async () => {
    window.sessionStorage.setItem(KEY, JSON.stringify(snapshot()));
    await analyzed();
    keepDestinationDraft("testnet", SOURCE, "GABC", "", null);
    expect(saved().destination).toBeNull();

    reload();
    await analyzed();
    const state = useDemolishStore.getState();
    expect(state.destinationAddress).toBeNull();
    expect(state.assetDispositions[AQUA]).toBe("issuer");
    expect(state.claimableBalanceSelections).toEqual({ [BALANCE]: "forfeit" });
  });
});

describe("the review confirm ends what is kept", () => {
  const step: PlannedStep = {
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

  async function confirmReview(): Promise<void> {
    spyOn(recovery, "readUnresolved").mockResolvedValue(null);
    spyOn(closeRecord, "saveCloseSession").mockResolvedValue("s");
    useDemolishStore.getState().setAddresses(SOURCE, DEST);
    useDemolishStore.setState({ phase: "PREFLIGHT_COMPLETE", executionPlan: [step] });
    window.sessionStorage.setItem(KEY, JSON.stringify(snapshot()));
    await mount(<ReviewView network="testnet" />);
    fireEvent.click(screen.getByRole("checkbox"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /want to proceed/i }));
    });
  }

  test("a successful confirm forgets the choices, and signing writes none back", async () => {
    await confirmReview();
    expect(useDemolishStore.getState().phase).toBe("STEP_EXECUTING");
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
    act(() => useDemolishStore.getState().setAssetDisposition(USDC, "convert"));
    keepDecisions("testnet", SOURCE);
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });

  test("a review reload right after the confirm goes to the start page, not to a second plan", async () => {
    await confirmReview();
    reload();
    await mount(<ReviewPage params={params} />);
    expect(replace).toHaveBeenCalledWith("/testnet");
    expect(replace).not.toHaveBeenCalledWith(expect.stringContaining("/analyze"));
  });
});

describe("a reload of review", () => {
  test("hands a restorable review back to analyze, showing a skeleton meanwhile", async () => {
    window.sessionStorage.setItem(KEY, JSON.stringify(snapshot()));
    await mount(<ReviewPage params={params} />);
    expect(screen.getByRole("status").textContent).toContain("Loading the review");
    expect(replace).toHaveBeenCalledWith(`/testnet/analyze?source=${encodeURIComponent(SOURCE)}`);
    expect(useDemolishStore.getState().reloadNotice).toContain(
      "Your choices for this account were kept"
    );
    expect(useDemolishStore.getState().executionPlan).toEqual([]);
  });

  const failures: Array<[string, string, string]> = [
    ["a corrupt value", "{not json", UNREADABLE],
    ["another version", JSON.stringify({ ...snapshot(), v: 99 }), OTHER_VERSION],
    ["another account", JSON.stringify(snapshot({ source: PAYEE })), OTHER_ACCOUNT],
  ];

  test.each(failures)(
    "%s lands on analyze with the reset banner and its reason",
    async (_, raw, reason) => {
      window.sessionStorage.setItem(KEY, raw);
      await mount(<ReviewPage params={params} />);
      expect(screen.getByRole("status")).toBeTruthy();
      expect(replace).toHaveBeenCalledWith(`/testnet/analyze?source=${encodeURIComponent(SOURCE)}`);

      replace.mockClear();
      cleanup();
      await analyzed();
      expect(
        screen.getByText(`Your review was reset because the page was reloaded: ${reason}.`, {
          exact: false,
        })
      ).toBeTruthy();
      expect(useDemolishStore.getState().assetDispositions).toEqual({});
    }
  );

  test("storage that cannot be read lands on the start page with the banner and the reason", async () => {
    const real = Object.getOwnPropertyDescriptor(window, "sessionStorage");
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get: () => {
        throw new Error("blocked");
      },
    });
    restoreStorage = () => real && Object.defineProperty(window, "sessionStorage", real);
    await mount(<ReviewPage params={params} />);
    expect(replace).toHaveBeenCalledWith("/testnet");
    expect(useDemolishStore.getState().reloadNotice).toBe(
      `Your review was reset because the page was reloaded: ${UNREADABLE}. Make your choices again, then continue to review.`
    );
  });
});

describe("the saved choices are left alone past review, and forgotten when the close ends", () => {
  test("neither execute nor complete reads them", async () => {
    window.sessionStorage.setItem(KEY, JSON.stringify(snapshot()));
    const read = spyOn(snapshots, "readDecisions");
    const source = spyOn(snapshots, "savedSource");
    await mount(<ExecutePage params={params} />);
    await mount(<CompletePage params={params} />);
    expect(read).not.toHaveBeenCalled();
    expect(source).not.toHaveBeenCalled();
    expect(useDemolishStore.getState().assetDispositions).toEqual({});
  });

  test("leaving a close forgets them, and a reload's emptied store does not", async () => {
    window.sessionStorage.setItem(KEY, JSON.stringify(snapshot()));
    useDemolishStore.getState().reset();
    expect(window.sessionStorage.getItem(KEY)).not.toBeNull();

    useDemolishStore.getState().setAddresses(SOURCE, DEST);
    useDemolishStore.getState().reset();
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });

  test("a confirmed merge forgets them", () => {
    window.sessionStorage.setItem(KEY, JSON.stringify(snapshot()));
    const merge = { index: 1, type: "MERGE", status: "pending" } as PlannedStep;
    const offers = { index: 0, type: "CANCEL_OFFERS", status: "pending" } as PlannedStep;
    useDemolishStore.setState({ executionPlan: [offers, merge] });
    useDemolishStore.getState().markCoveredConfirmed(["CANCEL_OFFERS"], "a".repeat(64));
    expect(window.sessionStorage.getItem(KEY)).not.toBeNull();
    useDemolishStore.getState().markCoveredConfirmed(["MERGE"], "b".repeat(64));
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });
});

describe("the start page after execute lost its plan to a reload", () => {
  function record(over: Partial<SessionRecord>): SessionRecord {
    return {
      version: 2,
      id: "s",
      network: "testnet",
      sourceAddress: SOURCE,
      destinationAddress: DEST,
      memo: null,
      memoType: null,
      mediatorRequired: false,
      completedSteps: [],
      currentStepIndex: 0,
      stepCount: 3,
      stepBase: 0,
      status: "in_progress",
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      ...over,
    };
  }

  async function home(session: SessionRecord | null): Promise<void> {
    spyOn(sessionRecovery, "useSessionRecovery").mockImplementation(() => ({
      session,
      checked: true,
      clearSession: () => {},
      reload: async () => {},
    }));
    await mount(
      <Suspense fallback={null}>
        <HomePage params={Promise.resolve({ network: "testnet" })} />
      </Suspense>
    );
  }

  test("execute with an emptied store sends the user home flagged as interrupted", async () => {
    await mount(<ExecutePage params={params} />);
    expect(replace).toHaveBeenCalledWith("/testnet");
    expect(useDemolishStore.getState().executeInterrupted).toBe(true);
  });

  test("a record with no confirmed step says a transaction may have been in flight", async () => {
    useDemolishStore.setState({ executeInterrupted: true });
    await home(record({}));
    const text = document.body.textContent ?? "";
    expect(text).toContain("This browser recorded no confirmed step");
    expect(text).toContain("a transaction may have been in flight");
    expect(text).not.toMatch(/nothing (?:has been|was|is) (?:signed or )?sent/i);
    expect(useDemolishStore.getState().executeInterrupted).toBe(false);
  });

  test("a record with confirmed steps states the count as this browser recorded it", async () => {
    useDemolishStore.setState({ executeInterrupted: true });
    await home(record({ currentStepIndex: 2 }));
    const text = document.body.textContent ?? "";
    expect(text).toContain("2 of 3 steps confirmed, as recorded in this browser");
    expect(text).toContain("Confirmed work stays confirmed on the network");
  });

  test("no record shows no notice", async () => {
    useDemolishStore.setState({ executeInterrupted: true });
    await home(null);
    expect(document.body.textContent ?? "").not.toContain("The page was reloaded");
  });
});
