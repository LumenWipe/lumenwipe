import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Suspense, type ReactElement } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";
import * as navigation from "next/navigation";
import HomePage from "@/app/[network]/page";
import AnalyzePage from "@/app/[network]/analyze/page";
import AllowancesPage from "@/app/[network]/allowances/page";
import ExecutePage from "@/app/[network]/execute/page";
import ReviewPage from "@/app/[network]/review/page";
import * as sessionRecovery from "@/hooks/useSessionRecovery";
import * as analyzeClient from "@/lib/api/analyze-client";
import { useDemolishStore } from "@/store/demolish";
import { useNetworkStore } from "@/store/network";
import type { AccountState } from "@/types/account";
import type { PlannedStep } from "@/types/plan";
import type { SessionRecord } from "@/types/session";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";

const ADDRESS = Keypair.random().publicKey();

function settled<T>(value: T): Promise<T> {
  return Object.assign(Promise.resolve(value), { status: "fulfilled", value });
}

const params = settled({ network: "testnet" as const });

function account(): AccountState {
  return {
    address: ADDRESS,
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
    defiPositions: emptyDefiPositionsResult(ADDRESS),
    defiPositionsWarnings: [],
  };
}

function mergeStep(): PlannedStep {
  return {
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
}

function stubNavigation(search = ""): void {
  const router = { push: () => {}, replace: () => {} };
  const query = new URLSearchParams(search);
  spyOn(navigation, "useRouter").mockImplementation(
    () => router as unknown as ReturnType<typeof navigation.useRouter>
  );
  spyOn(navigation, "useSearchParams").mockImplementation(
    () => query as unknown as ReturnType<typeof navigation.useSearchParams>
  );
}

async function renderPage(ui: ReactElement): Promise<void> {
  await act(async () => {
    render(<Suspense fallback={null}>{ui}</Suspense>);
  });
}

function expectIconControl(control: HTMLElement): void {
  expect(control.hasAttribute("tabindex")).toBe(false);
  expect(control.getAttribute("aria-hidden")).toBeNull();
  expect(control.className.split(" ")).toContain("size-6");
  for (const icon of Array.from(control.querySelectorAll("svg"))) {
    expect(icon.getAttribute("aria-hidden")).toBe("true");
  }
  control.focus();
  expect(document.activeElement).toBe(control);
}

beforeEach(() => {
  useDemolishStore.getState().reset();
  useNetworkStore.setState({ network: "testnet" });
  stubNavigation();
  spyOn(globalThis, "fetch").mockImplementation(
    (() => new Promise<Response>(() => {})) as unknown as typeof fetch
  );
});

afterEach(() => mock.restore());

test("the analyze back link is named after where it goes", async () => {
  stubNavigation(`source=${ADDRESS}`);
  spyOn(analyzeClient, "loadAnalysis").mockImplementation(async (deps) => {
    const acct = account();
    deps.applyAccount(acct);
    return {
      account: acct,
      plan: { blockers: [], decisionPoints: [] },
    } as unknown as analyzeClient.Analysis;
  });
  await renderPage(<AnalyzePage params={params} />);
  const back = await screen.findByRole("link", { name: "Back to account entry" });
  expect(back.getAttribute("href")).toBe("/testnet");
  expectIconControl(back);
});

test("the plan refresh button is named and reachable", async () => {
  stubNavigation(`source=${ADDRESS}`);
  spyOn(analyzeClient, "loadAnalysis").mockImplementation(async (deps) => {
    const acct = account();
    deps.applyAccount(acct);
    return {
      account: acct,
      plan: { blockers: [], decisionPoints: [] },
    } as unknown as analyzeClient.Analysis;
  });
  await renderPage(<AnalyzePage params={params} />);
  const refresh = await screen.findByRole("button", { name: "Refresh the plan" });
  expect(refresh.hasAttribute("tabindex")).toBe(false);
  expect(refresh.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
});

test("the allowance inspector back link is named after where it goes", async () => {
  await renderPage(<AllowancesPage params={params} />);
  const back = screen.getByRole("link", { name: "Back to account entry" });
  expect(back.getAttribute("href")).toBe("/testnet");
  expectIconControl(back);
});

test("the execute back link is named after where it goes", async () => {
  useDemolishStore.setState({
    executionPlan: [mergeStep()],
    phase: "STEP_EXECUTING",
    sourceAddress: ADDRESS,
  });
  await renderPage(<ExecutePage params={params} />);
  const back = screen.getByRole("link", { name: "Back to analyze" });
  expect(back.getAttribute("href")).toBe("/testnet/analyze");
  expectIconControl(back);
});

test("the review back button keeps its name and gains a 24px target", async () => {
  useDemolishStore.setState({
    executionPlan: [mergeStep()],
    phase: "PREFLIGHT_COMPLETE",
    sourceAddress: ADDRESS,
  });
  await renderPage(<ReviewPage params={params} />);
  const back = screen.getByRole("button", { name: "Back to analyze" });
  expect(back.getAttribute("type")).toBe("button");
  expect(back.className).not.toMatch(/outline-none/);
  expectIconControl(back);
});

test("the resume banner's buttons say what they do", async () => {
  spyOn(sessionRecovery, "useSessionRecovery").mockImplementation(() => ({
    session: {
      id: "s",
      network: "testnet",
      sourceAddress: ADDRESS,
      destinationAddress: ADDRESS,
      memo: null,
      completedSteps: [],
      currentStepIndex: 0,
      stepCount: 2,
      stepBase: 0,
      createdAt: "2026-10-01T00:00:00.000Z",
    } as unknown as SessionRecord,
    checked: true,
    clearSession: () => {},
    reload: async () => {},
  }));
  await renderPage(<HomePage params={params} />);
  await waitFor(() => screen.getByRole("button", { name: "Resume this close" }));
  const discard = screen.getByRole("button", { name: "Discard this record" });
  expect(discard.getAttribute("type")).toBe("button");
  expect(screen.getByRole("button", { name: "Resume this close" }).getAttribute("type")).toBe(
    "button"
  );
});
