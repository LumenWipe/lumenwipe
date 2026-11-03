import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Suspense } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";
import * as navigation from "next/navigation";
import NetworkLayout from "@/app/[network]/layout";
import ExecutePage from "@/app/[network]/execute/page";
import {
  LEAVE_CLOSE,
  LEAVE_CLOSE_IN_FLIGHT,
  LeaveGuardProvider,
} from "@/components/layout/LeaveGuard";
import NavBar from "@/components/layout/NavBar";
import * as closeExecution from "@/hooks/useCloseExecution";
import * as statsHook from "@/hooks/useStats";
import * as walletKit from "@/hooks/useWalletKitConnection";
import { deriveJourneyState, type JourneyStateName } from "@/lib/journey/journey-state";
import { exitRuleOf } from "@/lib/journey/exit-rule";
import { readUnresolved } from "@/lib/session/recovery";
import * as recovery from "@/lib/session/recovery";
import { saveSession, saveUnconfirmed } from "@/lib/session/store";
import { useDemolishStore } from "@/store/demolish";
import { useNetworkStore } from "@/store/network";
import type { PlannedStep, StepStatus, StepType } from "@/types/plan";
import { SESSION_RECORD_VERSION } from "@/types/session";
import { installIndexedDb, removeIndexedDb } from "./fixtures/indexed-db";

const SOURCE = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const SUBMISSION = { hash: "c".repeat(64), covers: ["MERGE"], validUntil: 5 };

function step(index: number, type: StepType, status: StepStatus): PlannedStep {
  return {
    index,
    type,
    title: type,
    description: "",
    operationCount: 1,
    estimatedFeeLumens: "0.0000100",
    txXdr: null,
    status,
    txHash: status === "confirmed" ? `hash${index}` : null,
    error: null,
  };
}

const PENDING = [step(0, "CANCEL_OFFERS", "pending"), step(1, "MERGE", "pending")];
const PARTLY = [step(0, "CANCEL_OFFERS", "confirmed"), step(1, "MERGE", "pending")];
const MERGED = [step(0, "CANCEL_OFFERS", "confirmed"), step(1, "MERGE", "confirmed")];

let calls: string[] = [];

function stubRouter(): void {
  calls = [];
  const router = {
    push: (path: string) => calls.push(`push ${path}`),
    replace: (path: string) => calls.push(`replace ${path}`),
  } as unknown as ReturnType<typeof navigation.useRouter>;
  spyOn(navigation, "useRouter").mockImplementation(() => router);
}

function stubExecution(): void {
  spyOn(closeExecution, "useCloseExecution").mockImplementation(
    () =>
      ({
        run: async () => {},
        progressStatus: null,
        signatureStatus: null,
        submitPreAuthTransaction: async () => {},
        checkUnconfirmed: async () => {},
        retrySafe: null,
        stillUnconfirmed: false,
      }) as unknown as ReturnType<typeof closeExecution.useCloseExecution>
  );
  spyOn(walletKit, "useWalletKitConnection").mockImplementation(
    () =>
      ({
        address: null,
        connecting: false,
        error: null,
        networkMismatch: false,
        connect: async () => {},
        disconnect: async () => {},
      }) as unknown as ReturnType<typeof walletKit.useWalletKitConnection>
  );
}

function settled<T>(value: T): Promise<T> {
  return Object.assign(Promise.resolve(value), { status: "fulfilled", value });
}

/** The store as a close mid-run leaves it: confirmed on review, signing on /execute. */
function seedClose(store: Partial<ReturnType<typeof useDemolishStore.getState>> = {}): void {
  useDemolishStore.getState().reset();
  useDemolishStore.getState().setAddresses(SOURCE, DEST);
  useDemolishStore.setState({
    phase: "STEP_EXECUTING",
    executionPlan: PENDING,
    sessionId: "s",
    signingRun: true,
    ...store,
  });
}

async function mountExecute(): Promise<void> {
  await act(async () => {
    render(
      <LeaveGuardProvider>
        <NavBar network="testnet" />
        <ExecutePage params={settled({ network: "testnet" as const })} />
      </LeaveGuardProvider>
    );
  });
}

beforeEach(() => {
  useNetworkStore.setState({ network: "testnet" });
  stubRouter();
  stubExecution();
  spyOn(navigation, "usePathname").mockReturnValue("/testnet/execute");
  spyOn(navigation, "useSearchParams").mockReturnValue(new URLSearchParams() as never);
});

afterEach(() => mock.restore());

describe("in-app exits mid-close", () => {
  for (const [name, link] of [
    ["the logo", () => screen.getByRole("link", { name: "LumenWipe home" })],
    ["the network switcher", () => screen.getByRole("link", { name: "Mainnet" })],
  ] as const) {
    test(`${name} asks first, and declining neither navigates nor resets`, async () => {
      seedClose();
      const reset = spyOn(useDemolishStore.getState(), "reset");
      await mountExecute();

      expect(fireEvent.click(link())).toBe(false);
      expect(screen.getByRole("dialog").textContent).toContain(LEAVE_CLOSE_IN_FLIGHT);
      fireEvent.click(screen.getByRole("button", { name: "Stay" }));

      expect(screen.queryByRole("dialog")).toBeNull();
      expect(reset).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
      expect(useDemolishStore.getState().sourceAddress).toBe(SOURCE);
      expect(screen.getByRole("heading", { name: /sign & execute/i })).toBeDefined();
    });
  }

  test("leaving ends this tab's close, then goes where the person chose", async () => {
    seedClose({ signingRun: false });
    await mountExecute();

    fireEvent.click(screen.getByRole("link", { name: "LumenWipe home" }));
    expect(screen.getByRole("dialog").textContent).toContain(LEAVE_CLOSE);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Leave" }));
    });

    expect(useDemolishStore.getState().sourceAddress).toBeNull();
    expect(calls.at(-1)).toBe("push /");
  });

  test("a click that opens a new tab or window does not ask", async () => {
    seedClose({ signingRun: false });
    await mountExecute();
    const logo = screen.getByRole("link", { name: "LumenWipe home" });
    for (const modifier of [
      { metaKey: true },
      { ctrlKey: true },
      { shiftKey: true },
      { altKey: true },
      { button: 1 },
    ]) {
      fireEvent.click(logo, modifier);
      expect(screen.queryByRole("dialog")).toBeNull();
    }
    expect(useDemolishStore.getState().sourceAddress).toBe(SOURCE);
  });

  test("before the review confirm the logo stays a plain link", async () => {
    seedClose({ phase: "PREFLIGHT_COMPLETE", sessionId: null, signingRun: false });
    await act(async () => {
      render(
        <LeaveGuardProvider>
          <NavBar network="testnet" />
        </LeaveGuardProvider>
      );
    });
    fireEvent.click(screen.getByRole("link", { name: "LumenWipe home" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("leaving while a transaction may be in flight", () => {
  beforeEach(installIndexedDb);
  afterEach(removeIndexedDb);

  test("keeps the durable hash, so the start page still finds it", async () => {
    await saveSession({
      version: SESSION_RECORD_VERSION,
      id: "s",
      network: "testnet",
      sourceAddress: SOURCE,
      destinationAddress: DEST,
      memo: null,
      memoType: null,
      mediatorRequired: false,
      completedSteps: [],
      currentStepIndex: 0,
      status: "in_progress",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(await saveUnconfirmed("s", SUBMISSION as never)).toBe(true);
    seedClose({
      phase: "STEP_UNCONFIRMED",
      signingRun: false,
      unconfirmedSubmission: SUBMISSION as never,
    });
    await mountExecute();

    fireEvent.click(screen.getByRole("link", { name: "LumenWipe home" }));
    expect(screen.getByRole("dialog").textContent).toContain(LEAVE_CLOSE_IN_FLIGHT);
    expect(screen.getByRole("dialog").textContent).not.toContain("stops signing");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Leave" }));
    });

    expect(useDemolishStore.getState().unconfirmedSubmission).toBeNull();
    expect((await readUnresolved("testnet", SOURCE))?.unconfirmed?.hash).toBe(SUBMISSION.hash);
  });
});

describe("the back control on /execute", () => {
  test("is disabled, with its name, while a transaction is in flight", async () => {
    seedClose();
    await mountExecute();
    const back = screen.getByRole("button", { name: "Back to analyze" });
    expect(back.hasAttribute("disabled")).toBe(true);
  });

  test("links back to analyze before anything is confirmed", async () => {
    seedClose({ signingRun: false });
    await mountExecute();
    expect(screen.getByRole("link", { name: "Back to analyze" }).getAttribute("href")).toBe(
      "/testnet/analyze"
    );
  });

  test("once a step is confirmed, becomes leave and resume later behind a confirm", async () => {
    seedClose({ executionPlan: PARTLY, signingRun: false });
    await mountExecute();
    expect(screen.queryByRole("link", { name: "Back to analyze" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Leave and resume later" }));
    expect(screen.getByRole("dialog").textContent).toContain(LEAVE_CLOSE);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Leave" }));
    });
    expect(calls.at(-1)).toBe("push /testnet");
  });
});

describe("closing the tab", () => {
  function unloadAsks(): boolean {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  }

  async function mountGuard(): Promise<ReturnType<typeof render>> {
    let view: ReturnType<typeof render> | undefined;
    await act(async () => {
      view = render(<LeaveGuardProvider>{null}</LeaveGuardProvider>);
    });
    return view!;
  }

  test("asks during a run, and on a confirmed step of an open close", async () => {
    seedClose();
    await mountGuard();
    expect(unloadAsks()).toBe(true);

    act(() => useDemolishStore.setState({ signingRun: false, phase: "STEP_FAILED" }));
    expect(unloadAsks()).toBe(false);

    act(() => useDemolishStore.setState({ executionPlan: PARTLY }));
    expect(unloadAsks()).toBe(true);
  });

  test("stops asking once the close is complete", async () => {
    seedClose({ executionPlan: PARTLY, signingRun: false });
    await mountGuard();
    expect(unloadAsks()).toBe(true);
    act(() => useDemolishStore.setState({ phase: "COMPLETE", executionPlan: MERGED }));
    expect(unloadAsks()).toBe(false);
  });

  test("stops asking on unmount", async () => {
    seedClose();
    const view = await mountGuard();
    expect(unloadAsks()).toBe(true);
    view.unmount();
    expect(unloadAsks()).toBe(false);
  });
});

describe("a network change reached mid-close", () => {
  function renderLayout(network: string, pathname: string): void {
    spyOn(navigation, "usePathname").mockReturnValue(pathname);
    spyOn(statsHook, "useStats").mockReturnValue({ stats: null, stale: false } as never);
    spyOn(recovery, "findUnresolved").mockResolvedValue(null);
    spyOn(recovery, "readUnresolved").mockResolvedValue(null);
    sessionStorage.setItem("lumenwipe_risk_accepted", "1");
    render(
      <Suspense fallback={null}>
        <NetworkLayout params={settled({ network })}>
          <p>page</p>
        </NetworkLayout>
      </Suspense>
    );
  }

  test("asks, shows nothing of the other network, and staying keeps the close", async () => {
    seedClose({ signingRun: false });
    const reset = spyOn(useDemolishStore.getState(), "reset");
    await act(async () => renderLayout("mainnet", "/mainnet/execute"));

    expect(screen.getByRole("dialog").textContent).toContain(LEAVE_CLOSE);
    expect(screen.queryByText("page")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stay" }));

    expect(reset).not.toHaveBeenCalled();
    expect(calls).toEqual(["replace /testnet/execute"]);
    expect(useNetworkStore.getState().network).toBe("testnet");
    expect(useDemolishStore.getState().sourceAddress).toBe(SOURCE);
  });

  test("staying keeps the query string of the page it goes back to", async () => {
    seedClose({ signingRun: false });
    spyOn(navigation, "useSearchParams").mockReturnValue(
      new URLSearchParams({ source: SOURCE }) as never
    );
    await act(async () => renderLayout("mainnet", "/mainnet/analyze"));
    fireEvent.click(screen.getByRole("button", { name: "Stay" }));
    expect(calls).toEqual([`replace /testnet/analyze?source=${SOURCE}`]);
  });

  test("leaving clears the close and moves to the other network", async () => {
    seedClose({ signingRun: false });
    await act(async () => renderLayout("mainnet", "/mainnet/execute"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Leave" }));
    });
    expect(useNetworkStore.getState().network).toBe("mainnet");
    expect(useDemolishStore.getState().sourceAddress).toBeNull();
  });

  test("outside a close the network changes without asking", async () => {
    useDemolishStore.getState().reset();
    useDemolishStore.getState().setAddresses(SOURCE, DEST);
    await act(async () => renderLayout("mainnet", "/mainnet"));
    expect(screen.queryByText(LEAVE_CLOSE)).toBeNull();
    expect(useNetworkStore.getState().network).toBe("mainnet");
    expect(useDemolishStore.getState().sourceAddress).toBeNull();
  });
});

describe("exit rule", () => {
  const CASES: Array<[JourneyStateName, Parameters<typeof deriveJourneyState>[0]]> = [
    ["untouched", { phase: "IDLE", plan: [], inFlight: false, saved: false }],
    ["planned", { phase: "ANALYZING", plan: PENDING, inFlight: false, saved: false }],
    ["reviewed", { phase: "PREFLIGHT_COMPLETE", plan: PENDING, inFlight: false, saved: false }],
    ["unknown", { phase: "PREFLIGHT_COMPLETE", plan: PENDING, inFlight: false, saved: true }],
    ["signing", { phase: "STEP_EXECUTING", plan: PENDING, inFlight: false, saved: true }],
    ["partial", { phase: "STEP_FAILED", plan: PARTLY, inFlight: false, saved: true }],
    ["complete", { phase: "COMPLETE", plan: MERGED, inFlight: false, saved: true }],
  ];

  test.each(CASES)("%s", (state, input) => {
    const journey = deriveJourneyState(input);
    expect(journey.state).toBe(state);
    const idle = exitRuleOf(journey, false);
    const running = exitRuleOf(journey, true);
    const midClose = state === "signing" || state === "partial";
    expect(idle.leave).toBe(midClose ? "confirm" : "free");
    expect(idle.back).toBe(state === "partial" ? "leave" : "analyze");
    expect(idle.warnOnUnload).toBe(state === "partial");
    expect(running.back).toBe("disabled");
    expect(running.warnOnUnload).toBe(true);
  });

  test("a transaction with an unsettled outcome counts as in flight", () => {
    const journey = deriveJourneyState({
      phase: "STEP_UNCONFIRMED",
      plan: PENDING,
      inFlight: true,
      saved: true,
    });
    expect(exitRuleOf(journey, false)).toEqual({
      leave: "confirm",
      inFlight: true,
      back: "disabled",
      warnOnUnload: true,
    });
  });
});
