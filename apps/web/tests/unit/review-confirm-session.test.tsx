import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";
import * as navigation from "next/navigation";
import ReviewView from "@/components/review/ReviewView";
import * as recovery from "@/lib/session/recovery";
import * as sessionStore from "@/lib/session/store";
import { useDemolishStore } from "@/store/demolish";
import { useNetworkStore } from "@/store/network";
import { CONFIRM_HELD, CONFIRM_UNCHECKED } from "@/lib/utils/user-error";
import type { PlannedStep } from "@/types/plan";
import type { SessionRecord, UnconfirmedRecord } from "@/types/session";

const SOURCE = Keypair.random().publicKey();
const OLD_DEST = Keypair.random().publicKey();
const NEW_DEST = Keypair.random().publicKey();

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

const PROGRESS: SessionRecord = {
  id: "s",
  network: "testnet",
  sourceAddress: SOURCE,
  destinationAddress: OLD_DEST,
  memo: null,
  memoType: null,
  mediatorRequired: false,
  completedSteps: [
    {
      index: 0,
      type: "REMOVE_TRUSTLINES",
      txHash: "a".repeat(64),
      confirmedAt: "2026-10-01T00:00:00.000Z",
    },
    {
      index: 1,
      type: "CANCEL_OFFERS",
      txHash: "b".repeat(64),
      confirmedAt: "2026-10-01T00:01:00.000Z",
    },
  ],
  currentStepIndex: 2,
  status: "in_progress",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:01:00.000Z",
};

/** An in-memory sessions store answering both plain reads and writes and a readwrite transaction. */
function fakeDb(seed: SessionRecord[]) {
  const rows = new Map(seed.map((r) => [r.id, structuredClone(r)]));
  const store = {
    get: async (id: string) => rows.get(id),
    put: async (record: SessionRecord) => void rows.set(record.id, record),
  };
  spyOn(sessionStore, "getDb").mockImplementation((async () => ({
    get: async (_name: string, id: string) => store.get(id),
    put: async (_name: string, record: SessionRecord) => store.put(record),
    getAll: async () => [...rows.values()],
    transaction: () => ({ store, done: Promise.resolve() }),
  })) as never);
  return rows;
}

function stubRouter() {
  const calls: string[] = [];
  spyOn(navigation, "useRouter").mockImplementation(
    () =>
      ({
        push: (path: string) => calls.push(`push ${path}`),
        replace: (path: string) => calls.push(`replace ${path}`),
      }) as unknown as ReturnType<typeof navigation.useRouter>
  );
  return calls;
}

async function confirm() {
  await act(async () => {
    render(<ReviewView network="testnet" />);
  });
  fireEvent.click(screen.getByRole("checkbox"));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /want to proceed/i }));
  });
}

beforeEach(() => {
  useNetworkStore.setState({ network: "testnet" });
  useDemolishStore.getState().reset();
  useDemolishStore.getState().setAddresses(SOURCE, NEW_DEST);
  useDemolishStore.getState().setPlan([STEP]);
  useDemolishStore.getState().setPhase("PREFLIGHT_COMPLETE");
});

afterEach(() => mock.restore());

test("confirming again keeps the saved close's progress and creation time", async () => {
  const rows = fakeDb([PROGRESS]);
  const calls = stubRouter();
  useDemolishStore.setState({ sessionId: "s" });

  await confirm();

  const kept = rows.get("s");
  expect(kept?.completedSteps).toEqual(PROGRESS.completedSteps);
  expect(kept?.currentStepIndex).toBe(2);
  expect(kept?.createdAt).toBe(PROGRESS.createdAt);
  expect(kept?.destinationAddress).toBe(NEW_DEST);
  expect(useDemolishStore.getState().phase).toBe("STEP_EXECUTING");
  expect(calls).toEqual(["push /testnet/execute"]);
});

test("a resumed close confirmed on review keeps its saved progress", async () => {
  const rows = fakeDb([PROGRESS]);
  stubRouter();
  useDemolishStore.getState().restoreSession("s");

  await confirm();

  expect(rows.get("s")?.completedSteps).toEqual(PROGRESS.completedSteps);
  expect(rows.get("s")?.currentStepIndex).toBe(2);
  expect(rows.get("s")?.createdAt).toBe(PROGRESS.createdAt);
});

const HASH: UnconfirmedRecord = { hash: "c".repeat(64), covers: ["MERGE"], validUntil: 5 };

function expectNotStarted(
  rows: Map<string, SessionRecord>,
  before: SessionRecord[],
  calls: string[]
) {
  expect([...rows.values()]).toEqual(before);
  expect(useDemolishStore.getState().phase).toBe("PREFLIGHT_COMPLETE");
  expect(calls).toEqual([]);
}

test("a saved hash of this account with an unknown outcome holds the confirm", async () => {
  const other = { ...PROGRESS, id: "other", unconfirmed: HASH };
  const rows = fakeDb([other]);
  const calls = stubRouter();

  await confirm();

  expect(screen.getByRole("alert").textContent).toContain(CONFIRM_HELD);
  expectNotStarted(rows, [other], calls);
});

test("a hash held in this tab holds the confirm", async () => {
  const rows = fakeDb([]);
  const calls = stubRouter();
  useDemolishStore.setState({ unconfirmedSubmission: HASH as never });

  await confirm();

  expect(screen.getByRole("alert").textContent).toContain(CONFIRM_HELD);
  expectNotStarted(rows, [], calls);
});

test("a saved state that cannot be read holds the confirm instead of counting as no hold", async () => {
  const rows = fakeDb([]);
  const calls = stubRouter();
  spyOn(recovery, "readUnresolved").mockRejectedValue(new Error("storage unavailable"));

  await confirm();

  expect(screen.getByRole("alert").textContent).toContain(CONFIRM_UNCHECKED);
  expectNotStarted(rows, [], calls);
  expect(useDemolishStore.getState().sessionId).toBeNull();
});
