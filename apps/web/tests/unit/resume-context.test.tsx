import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import { Suspense } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";
import * as navigation from "next/navigation";
import AnalyzePage from "@/app/[network]/analyze/page";
import ExecutePage from "@/app/[network]/execute/page";
import HomePage from "@/app/[network]/page";
import ReviewPage from "@/app/[network]/review/page";
import { formatStartedAt } from "@/components/execution/ResumeBanner";
import ReviewView from "@/components/review/ReviewView";
import * as sessionRecovery from "@/hooks/useSessionRecovery";
import * as closeRecord from "@/lib/session/close-record";
import * as recovery from "@/lib/session/recovery";
import { clearRecordsOfGoneAccount } from "@/lib/session/recovery";
import * as sessionStore from "@/lib/session/store";
import { listSessions, saveSession, saveUnconfirmed } from "@/lib/session/store";
import { GONE_RECORD_CLEARED } from "@/lib/utils/user-error";
import { useDemolishStore, type ResumedClose } from "@/store/demolish";
import { useNetworkStore } from "@/store/network";
import type { PlannedStep } from "@/types/plan";
import { SESSION_RECORD_VERSION, type SessionRecord } from "@/types/session";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";
import { installIndexedDb, removeIndexedDb } from "./fixtures/indexed-db";

const NOW = new Date("2026-11-03T12:00:00.000Z");
const SOURCE = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const params = Object.assign(Promise.resolve({ network: "testnet" as const }), {
  status: "fulfilled",
  value: { network: "testnet" as const },
});

function record(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    version: SESSION_RECORD_VERSION,
    id: "s",
    network: "testnet",
    sourceAddress: SOURCE,
    destinationAddress: DEST,
    memo: null,
    memoType: null,
    mediatorRequired: false,
    completedSteps: [
      { index: 0, type: "CANCEL_OFFERS", txHash: HASH_A, confirmedAt: NOW.toISOString() },
      { index: 1, type: "REMOVE_TRUSTLINES", txHash: HASH_B, confirmedAt: NOW.toISOString() },
    ],
    currentStepIndex: 2,
    stepCount: 3,
    stepBase: 0,
    status: "in_progress",
    createdAt: "2026-11-01T09:30:00.000Z",
    updatedAt: NOW.toISOString(),
    ...over,
  };
}

const RESUMED: ResumedClose = {
  source: SOURCE,
  startedAt: "2026-11-01T09:30:00.000Z",
  completedSteps: record().completedSteps,
};

let push: ReturnType<typeof mock>;
let replace: ReturnType<typeof mock>;

async function mount(ui: React.ReactElement): Promise<void> {
  await act(async () => {
    render(ui);
  });
}

async function home(session: SessionRecord, reload = async () => {}): Promise<void> {
  spyOn(sessionRecovery, "useSessionRecovery").mockImplementation(() => ({
    session,
    checked: true,
    clearSession: () => {},
    reload,
  }));
  await mount(
    <Suspense fallback={null}>
      <HomePage params={Promise.resolve({ network: "testnet" })} />
    </Suspense>
  );
}

function stubFetch(accountGone = false): void {
  spyOn(globalThis, "fetch").mockImplementation((async (input: unknown) => {
    const url = String(input);
    if (url.includes("/account/")) {
      if (accountGone) {
        return Response.json(
          { error: { code: "account_not_found", message: "raw" } },
          { status: 404 }
        );
      }
      return Response.json({
        address: SOURCE,
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
        defiPositions: emptyDefiPositionsResult(SOURCE),
        defiPositionsWarnings: [],
      });
    }
    if (url.includes("/close/plan")) {
      return Response.json({ status: "ready", blockers: [], steps: [], decisionPoints: [] });
    }
    return Response.json({});
  }) as unknown as typeof fetch);
}

beforeEach(() => {
  setSystemTime(NOW);
  window.sessionStorage.clear();
  useDemolishStore.getState().reset();
  useNetworkStore.setState({ network: "testnet" });
  push = mock(() => {});
  replace = mock(() => {});
  const router = { push, replace };
  spyOn(navigation, "useRouter").mockImplementation(() => router as never);
  spyOn(navigation, "useSearchParams").mockImplementation(
    () => new URLSearchParams(`source=${SOURCE}`) as never
  );
});

afterEach(() => {
  cleanup();
  mock.restore();
  setSystemTime();
});

describe("the resume banner", () => {
  test("shows the account, destination, network, start time and recorded progress", async () => {
    await home(record());
    const banner = screen.getByRole("region", { name: /A close you started is saved/ });
    const text = banner.textContent ?? "";
    expect(text).toContain(`${SOURCE.slice(0, 6)}...${SOURCE.slice(-6)}`);
    expect(text).toContain(`${DEST.slice(0, 6)}...${DEST.slice(-6)}`);
    expect(within(banner).getByText(DEST)).toBeTruthy();
    expect(text).toContain("Testnet");
    expect(text).toContain(formatStartedAt("2026-11-01T09:30:00.000Z"));
    expect(text).toContain("2 of 3 steps confirmed, as recorded in this browser");
    expect(text).toContain("goes through analyze and review again");
    expect(within(banner).getByRole("button", { name: "Resume this close" })).toBeTruthy();
    expect(within(banner).getByRole("button", { name: "Discard this record" })).toBeTruthy();
  });

  test("discarding asks first, and cancelling keeps the record", async () => {
    const remove = spyOn(sessionStore, "deleteSettledSession").mockResolvedValue(true);
    await home(record());
    fireEvent.click(screen.getByRole("button", { name: "Discard this record" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Your account on the network is not touched");
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep the record" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(remove).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Discard this record" }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Discard" }));
    });
    expect(remove).toHaveBeenCalledWith("s");
  });

  test("resuming sets no phase and no plan, so review and execute send it back to analysis", async () => {
    await home(record());
    fireEvent.click(screen.getByRole("button", { name: "Resume this close" }));
    expect(push).toHaveBeenCalledWith(`/testnet/analyze?source=${encodeURIComponent(SOURCE)}`);
    const state = useDemolishStore.getState();
    expect(state.phase).toBe("IDLE");
    expect(state.executionPlan).toEqual([]);
    expect(state.planHash).toBeNull();
    expect(state.resumedClose).toEqual(RESUMED);
    cleanup();

    await mount(<ReviewPage params={params} />);
    expect(replace).toHaveBeenLastCalledWith("/testnet/analyze");
    expect(screen.queryByRole("heading", { name: /Review the full plan/ })).toBeNull();
    cleanup();

    await mount(<ExecutePage params={params} />);
    expect(replace).toHaveBeenLastCalledWith("/testnet");
    expect(screen.queryByRole("heading", { name: /Executing plan/ })).toBeNull();
  });
});

describe("a resumed close on analyze and review", () => {
  test("analyze lists the confirmed transactions and their hashes from the record", async () => {
    stubFetch();
    useDemolishStore.getState().setAddresses(SOURCE, DEST);
    useDemolishStore.setState({ resumedClose: RESUMED, sessionId: "s" });
    await mount(<AnalyzePage params={params} />);
    const notice = await screen.findByText(/Continuing a close you started on/);
    const box = notice.parentElement!.parentElement!;
    expect(box.textContent).toContain(formatStartedAt(RESUMED.startedAt));
    expect(box.textContent).toContain("as recorded in this browser");
    expect(within(box).getByText(HASH_A).getAttribute("href")).toContain(`/tx/${HASH_A}`);
    expect(within(box).getByText(HASH_B)).toBeTruthy();
    expect(box.textContent).toContain("Cancel offers");
    expect(box.textContent).toContain("Remove trustlines");
  });

  test("analyze of another account shows no resume notice", async () => {
    stubFetch();
    useDemolishStore.setState({
      resumedClose: { ...RESUMED, source: Keypair.random().publicKey() },
    });
    await mount(<AnalyzePage params={params} />);
    await screen.findByText("Account analyzed");
    expect(screen.queryByText(/Continuing a close/)).toBeNull();
  });

  const LINE = /this plan lists only what is left on the account now/;
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

  test("review states that the plan lists only what is left, in resume mode only", async () => {
    spyOn(recovery, "readUnresolved").mockResolvedValue(null);
    spyOn(closeRecord, "saveCloseSession").mockResolvedValue("s");
    useDemolishStore.getState().setAddresses(SOURCE, DEST);
    useDemolishStore.setState({ phase: "PREFLIGHT_COMPLETE", executionPlan: [step] });
    await mount(<ReviewView network="testnet" />);
    expect(screen.queryByText(LINE)).toBeNull();
    cleanup();

    useDemolishStore.setState({ resumedClose: RESUMED, sessionId: "s" });
    await mount(<ReviewView network="testnet" />);
    expect(screen.getByText(LINE)).toBeTruthy();
  });
});

describe("an account the network no longer has", () => {
  test("analyze removes its saved close and says so", async () => {
    stubFetch(true);
    const clear = spyOn(recovery, "clearRecordsOfGoneAccount").mockResolvedValue(1);
    useDemolishStore.setState({ resumedClose: RESUMED });
    await mount(<AnalyzePage params={params} />);
    await waitFor(() => expect(screen.getByText(GONE_RECORD_CLEARED)).toBeTruthy());
    expect(clear).toHaveBeenCalledWith("testnet", SOURCE);
    expect(useDemolishStore.getState().resumedClose).toBeNull();
    expect(GONE_RECORD_CLEARED).not.toMatch(/account is closed|account closed|close is finished/i);
  });

  test("analyze says nothing about a record when none was removed", async () => {
    stubFetch(true);
    spyOn(recovery, "clearRecordsOfGoneAccount").mockResolvedValue(0);
    await mount(<AnalyzePage params={params} />);
    await screen.findByText(/couldn't find that on this network/);
    expect(screen.queryByText(GONE_RECORD_CLEARED)).toBeNull();
  });

  describe("which records go", () => {
    beforeEach(() => installIndexedDb());
    afterEach(() => removeIndexedDb());

    test("only this network's and account's, and never one holding an unconfirmed hash", async () => {
      const other = Keypair.random().publicKey();
      await saveSession(record({ id: "same" }));
      await saveSession(record({ id: "held" }));
      await saveUnconfirmed("held", { hash: HASH_A, covers: ["MERGE"], validUntil: 5 } as never);
      await saveSession(record({ id: "mainnet", network: "mainnet" }));
      await saveSession(record({ id: "other", sourceAddress: other }));

      expect(await clearRecordsOfGoneAccount("testnet", SOURCE)).toBe(1);
      const left = (await listSessions()).map((s) => s.id).sort();
      expect(left).toEqual(["held", "mainnet", "other"]);
      expect((await listSessions()).find((s) => s.id === "held")?.unconfirmed?.hash).toBe(HASH_A);
    });
  });
});
