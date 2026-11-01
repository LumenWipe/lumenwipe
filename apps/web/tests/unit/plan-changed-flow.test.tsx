import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";
import * as navigation from "next/navigation";
import ExecutePage from "@/app/[network]/execute/page";
import ReviewPage from "@/app/[network]/review/page";
import HomePage from "@/app/[network]/page";
import { useDemolishStore } from "@/store/demolish";
import * as recovery from "@/lib/session/recovery";
import type { SessionRecord } from "@/types/session";
import type { PlannedStep } from "@/types/plan";

const SOURCE = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();

const STALE_STEP: PlannedStep = {
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

function settled<T>(value: T): Promise<T> {
  return Object.assign(Promise.resolve(value), { status: "fulfilled", value });
}

function stubRouter() {
  const calls: string[] = [];
  const router = {
    push: (path: string) => calls.push(`push ${path}`),
    replace: (path: string) => calls.push(`replace ${path}`),
  };
  spyOn(navigation, "useRouter").mockImplementation(
    () => router as unknown as ReturnType<typeof navigation.useRouter>
  );
  return calls;
}

beforeEach(() => {
  useDemolishStore.getState().reset();
  useDemolishStore.setState({ sourceAddress: SOURCE, destinationAddress: DEST });
  useDemolishStore.getState().setPlan([STALE_STEP]);
  useDemolishStore.getState().setPhase("STEP_EXECUTING");
});
afterEach(() => {
  mock.restore();
});

test("a discarded plan sends /execute back to /analyze for a fresh plan", async () => {
  const calls = stubRouter();
  await act(async () => {
    render(<ExecutePage params={settled({ network: "testnet" as const })} />);
  });
  act(() => useDemolishStore.getState().discardPlan("changed"));
  await waitFor(() => expect(calls).toContain("replace /testnet/analyze"));
});

test("a discarded plan cannot be confirmed again on /review", async () => {
  const calls = stubRouter();
  useDemolishStore.getState().discardPlan("changed");
  await act(async () => {
    render(<ReviewPage params={settled({ network: "testnet" as const })} />);
  });
  expect(calls).toContain("replace /testnet/analyze");
  expect(screen.queryByRole("button", { name: /confirm|close|begin/i })).toBeNull();
  expect(useDemolishStore.getState().phase).not.toBe("STEP_EXECUTING");
});

test("resuming the saved close record re-plans from /analyze, never the discarded plan", async () => {
  const calls = stubRouter();
  useDemolishStore.getState().discardPlan("changed");
  const record: SessionRecord = {
    id: "session-1",
    network: "testnet",
    sourceAddress: SOURCE,
    destinationAddress: DEST,
    memo: null,
    memoType: null,
    mediatorRequired: false,
    completedSteps: [],
    currentStepIndex: 0,
    status: "in_progress",
    createdAt: "2026-10-31T00:00:00.000Z",
    updatedAt: "2026-10-31T00:00:00.000Z",
  };
  spyOn(recovery, "findResumableSession").mockResolvedValue(record);
  await act(async () => {
    render(<HomePage params={settled({ network: "testnet" as const })} />);
  });
  fireEvent.click(await screen.findByRole("button", { name: "Resume" }));

  expect(calls).toEqual([`push /testnet/analyze?source=${encodeURIComponent(SOURCE)}`]);
  const state = useDemolishStore.getState();
  expect(state.executionPlan).toEqual([]);
  expect(state.phase).not.toBe("STEP_EXECUTING");
});
