import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { Keypair } from "@stellar/stellar-sdk";
import * as navigation from "next/navigation";
import CompletionReceipt from "@/components/complete/CompletionReceipt";
import NetworkLoading from "@/app/[network]/loading";
import ReviewPage from "@/app/[network]/review/page";
import AnalyzePage from "@/app/[network]/analyze/page";
import AllowancesPage from "@/app/[network]/allowances/page";
import { useDemolishStore } from "@/store/demolish";
import * as history from "@/lib/session/history";
import * as recovery from "@/lib/session/recovery";
import * as analyzeClient from "@/lib/api/analyze-client";
import type { AccountState } from "@/types/account";
import type { PlannedStep, StepStatus, StepType } from "@/types/plan";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";

const VALID_ADDRESS = Keypair.random().publicKey();
const ADDRESS = "GSOURCE0000000000000000000000000000000000000000000000000";

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

// React's use() only skips suspending for a thenable it has already seen settle.
function settled<T>(value: T): Promise<T> {
  return Object.assign(Promise.resolve(value), { status: "fulfilled", value });
}

// Stable identities: the analyze page re-fetches whenever its router changes.
function stubNavigation(search = ""): void {
  const router = { push: () => {}, replace: () => {} };
  const params = new URLSearchParams(search);
  spyOn(navigation, "useRouter").mockImplementation(
    () => router as unknown as ReturnType<typeof navigation.useRouter>
  );
  spyOn(navigation, "useSearchParams").mockImplementation(
    () => params as unknown as ReturnType<typeof navigation.useSearchParams>
  );
}

function expectValidOutline(): void {
  const levels = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6")).map((h) =>
    Number(h.tagName[1])
  );
  expect(levels.filter((l) => l === 1)).toHaveLength(1);
  expect(levels[0]).toBe(1);
  levels.forEach((level, i) => {
    if (i > 0) expect(level - levels[i - 1]).toBeLessThanOrEqual(1);
  });
}

async function renderPage(ui: ReactElement): Promise<void> {
  await act(async () => {
    render(ui);
  });
}

beforeEach(() => {
  useDemolishStore.getState().reset();
  spyOn(history, "saveHistory").mockResolvedValue(undefined);
  spyOn(recovery, "cleanupSession").mockResolvedValue(undefined);
  stubNavigation();
});

afterEach(() => {
  mock.restore();
});

function seedClosed(): void {
  useDemolishStore.setState({
    executionPlan: [step(0, "MERGE", "confirmed")],
    phase: "COMPLETE",
    sessionId: "session-1",
    sourceAddress: ADDRESS,
    destinationAddress: "GDESTPLACEHOLDER",
  });
}

test("the receipt has one h1, a valid outline and focus on its heading", async () => {
  seedClosed();
  await renderPage(<CompletionReceipt network="testnet" />);
  expectValidOutline();
  const h1 = screen.getByRole("heading", { level: 1 });
  expect(h1.textContent).toBe("Account successfully merged");
  expect(document.activeElement).toBe(h1);
  expect(screen.getByRole("status").contains(h1)).toBe(true);
});

test("an incomplete close focuses its own heading", async () => {
  useDemolishStore.setState({
    executionPlan: [step(0, "CANCEL_OFFERS", "confirmed"), step(1, "MERGE", "pending")],
    phase: "STEP_FAILED",
    sourceAddress: ADDRESS,
    destinationAddress: "GDESTPLACEHOLDER",
  });
  await renderPage(<CompletionReceipt network="testnet" />);
  expectValidOutline();
  expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 }));
  expect(document.activeElement?.textContent).toBe("Close not finished");
});

test("the loading fallback is a labelled status with a decorative spinner", () => {
  const { container } = render(<NetworkLoading />);
  const status = screen.getByRole("status");
  expect(status.textContent).toBe("Loading");
  expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
});

test("review focuses the page heading and announces the plan once", async () => {
  useDemolishStore.setState({
    executionPlan: [step(0, "CANCEL_OFFERS", "pending"), step(1, "MERGE", "pending")],
    phase: "PREFLIGHT_COMPLETE",
    sourceAddress: ADDRESS,
    destinationAddress: "GDESTPLACEHOLDER",
  });
  await renderPage(<ReviewPage params={settled({ network: "testnet" as const })} />);
  expectValidOutline();
  expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 }));
  const statuses = screen.getAllByRole("status");
  expect(statuses).toHaveLength(1);
  expect(statuses[0].textContent).toBe("Plan ready to review: 2 steps.");
});

function stubAnalysis(): void {
  spyOn(analyzeClient, "loadAnalysis").mockImplementation(async (deps) => {
    const acct = account();
    deps.applyAccount(acct);
    return {
      account: acct,
      plan: { blockers: [], decisionPoints: [] },
    } as unknown as analyzeClient.Analysis;
  });
}

test("analyze announces the load through one status region and focuses the h1", async () => {
  stubNavigation(`source=${ADDRESS}`);
  stubAnalysis();
  await renderPage(<AnalyzePage params={settled({ network: "testnet" as const })} />);
  await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toBeDefined());
  expectValidOutline();
  expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1 }));
  const statuses = screen.getAllByRole("status");
  expect(statuses).toHaveLength(1);
  expect(statuses[0].textContent).toBe("Account analyzed");
});

test("the analyze loading view is a status region", async () => {
  stubNavigation(`source=${ADDRESS}`);
  spyOn(analyzeClient, "loadAnalysis").mockImplementation(() => new Promise(() => {}));
  await renderPage(<AnalyzePage params={settled({ network: "testnet" as const })} />);
  expect(screen.getByRole("status").textContent).toContain("Analyzing account");
});

test("allowances keeps one h1, announces lookups and marks results busy", async () => {
  let resolveFetch: (r: Response) => void = () => {};
  spyOn(globalThis, "fetch").mockImplementation(
    (() => new Promise<Response>((resolve) => (resolveFetch = resolve))) as unknown as typeof fetch
  );
  await renderPage(<AllowancesPage params={settled({ network: "testnet" as const })} />);
  expectValidOutline();

  fireEvent.change(screen.getByPlaceholderText(/G\.\.\./), { target: { value: VALID_ADDRESS } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Inspect/ }));
  });
  expect(screen.getByRole("status").textContent).toBe("Looking up allowances");

  const empty = () =>
    new Response(
      JSON.stringify({
        allowances: [],
        warnings: [],
        coverage: [
          { source: "events", status: "ok" },
          { source: "registry", status: "ok" },
        ],
      })
    );
  await act(async () => {
    resolveFetch(empty());
  });
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toBe("No outstanding allowances")
  );
  expect(document.querySelector("[aria-busy]")?.getAttribute("aria-busy")).toBe("false");

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Inspect/ }));
  });
  expect(document.querySelector("[aria-busy]")?.getAttribute("aria-busy")).toBe("true");
  await act(async () => {
    resolveFetch(empty());
  });
});

test("an allowance lookup failure is announced as an alert", async () => {
  spyOn(globalThis, "fetch").mockImplementation((async () => {
    throw new Error("boom");
  }) as unknown as typeof fetch);
  await renderPage(<AllowancesPage params={settled({ network: "testnet" as const })} />);
  fireEvent.change(screen.getByPlaceholderText(/G\.\.\./), { target: { value: VALID_ADDRESS } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Inspect/ }));
  });
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Failed to read allowances");
  expect(alert.textContent).not.toContain("boom");
});
