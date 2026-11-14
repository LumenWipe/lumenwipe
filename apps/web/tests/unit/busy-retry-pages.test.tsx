import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";
import * as navigation from "next/navigation";
import AnalyzePage from "@/app/[network]/analyze/page";
import PlanView from "@/components/plan/PlanView";
import ReviewView from "@/components/review/ReviewView";
import { fetchCloseTransactions } from "@/lib/api/close-client";
import { signatureOf } from "@/lib/plan/plan-freshness";
import { refreshReviewedPlan } from "@/lib/plan/refresh-plan";
import * as closeRecord from "@/lib/session/close-record";
import * as recovery from "@/lib/session/recovery";
import { ApiRequestError } from "@/lib/utils/user-error";
import { useDemolishStore } from "@/store/demolish";
import { useNetworkStore } from "@/store/network";
import type { PlannedStep } from "@/types/plan";
import { freshAccount, freshPlan } from "./fixtures/fresh-plan";
import { installIndexedDb, removeIndexedDb } from "./fixtures/indexed-db";

const SOURCE = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const BUSY_COPY = "busy or not answering right now. This is not a problem with your connection.";
const REFRESH_BUSY_COPY =
  "is busy or not answering, so signing has not started. This is not a problem with your connection.";

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
const PLAN = freshPlan([STEP], { planHash: "a".repeat(64) });

const params = Object.assign(Promise.resolve({ network: "testnet" as const }), {
  status: "fulfilled",
  value: { network: "testnet" as const },
});

function busy(retryAfter: string): Response {
  return Response.json(
    { error: { code: "service_unavailable", message: "The data provider is busy right now." } },
    { status: 503, headers: { "Retry-After": retryAfter } }
  );
}

type Answer = () => Response | Promise<Response>;

/** Answers each route's requests in turn, the last answer repeating, and counts them. */
function stubFetch(routes: {
  account?: Answer[];
  plan?: Answer[];
  check?: Answer[];
  tx?: Answer[];
}) {
  const seen = { account: 0, plan: 0, check: 0, tx: 0 };
  const next = (list: Answer[] | undefined, n: number, fallback: Answer): Promise<Response> =>
    Promise.resolve((list?.[Math.min(n, list.length - 1)] ?? fallback)());
  spyOn(globalThis, "fetch").mockImplementation((async (input: unknown) => {
    const url = String(input);
    if (url.includes("/close/transactions")) return next(routes.tx, seen.tx++, () => busy("0"));
    if (url.includes("/close/plan"))
      return next(routes.plan, seen.plan++, () => Response.json(PLAN));
    if (url.includes("/mediator/check/")) {
      return next(routes.check, seen.check++, () =>
        Response.json({ requiresMediator: false, available: true })
      );
    }
    if (url.includes("/account/")) {
      return next(routes.account, seen.account++, () => Response.json(freshAccount(SOURCE)));
    }
    return Response.json({});
  }) as unknown as typeof fetch);
  return seen;
}

const pause = (ms: number): Promise<void> =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

let pushed: string[] = [];

beforeEach(() => {
  installIndexedDb();
  pushed = [];
  useDemolishStore.getState().reset();
  useNetworkStore.setState({ network: "testnet" });
  const router = { push: (path: string) => pushed.push(path), replace: () => {} };
  spyOn(navigation, "useRouter").mockImplementation(() => router as never);
  spyOn(navigation, "useSearchParams").mockImplementation(
    () => new URLSearchParams(`source=${SOURCE}`) as never
  );
  spyOn(recovery, "readUnresolved").mockResolvedValue(null);
  spyOn(closeRecord, "saveCloseSession").mockResolvedValue("s");
});

afterEach(() => {
  cleanup();
  mock.restore();
  removeIndexedDb();
});

async function analyze(): Promise<void> {
  await act(async () => {
    render(<AnalyzePage params={params} />);
  });
}

test("an analysis whose account read is busy once asks again on its own and shows the account", async () => {
  const seen = stubFetch({ account: [() => busy("0"), () => Response.json(freshAccount(SOURCE))] });
  await analyze();
  await screen.findByRole("heading", { name: "Decide what happens to each item" });
  expect(seen.account).toBe(2);
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
});

test("an analysis whose plan is busy once asks again on its own", async () => {
  const seen = stubFetch({ plan: [() => busy("0"), () => Response.json(PLAN)] });
  await analyze();
  await screen.findByRole("heading", { name: "Decide what happens to each item" });
  expect(seen.plan).toBe(2);
  expect(seen.account).toBe(1);
});

test("the wait is shown with its seconds and a way to stop it", async () => {
  stubFetch({ account: [() => busy("30")] });
  await analyze();
  const notice = await screen.findByTestId("busy-retry");
  expect(notice.getAttribute("role")).toBe("status");
  expect(notice.textContent).toContain(BUSY_COPY);
  expect(notice.textContent).toContain("try again on its own in about 30 seconds");
  expect(screen.getByRole("button", { name: "Stop waiting" })).toBeTruthy();
});

test("stopping the wait shows the busy answer at once, with a manual retry, and asks nothing more", async () => {
  const seen = stubFetch({
    account: [() => busy("30"), () => Response.json(freshAccount(SOURCE))],
  });
  await analyze();
  await act(async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Stop waiting" }));
  });
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain(BUSY_COPY);
  expect(alert.textContent).toContain("Try again in about 30 seconds.");
  expect(screen.queryByTestId("busy-retry")).toBeNull();
  expect(seen.account).toBe(1);

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  });
  await screen.findByRole("heading", { name: "Decide what happens to each item" });
  expect(seen.account).toBe(2);
});

test("a second busy answer is shown with the manual retry, after one automatic retry", async () => {
  const seen = stubFetch({ account: [() => busy("0")] });
  await analyze();
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain(BUSY_COPY);
  expect(seen.account).toBe(2);
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
});

test("leaving the page during the wait cancels the pending retry", async () => {
  const seen = stubFetch({ account: [() => busy("1"), () => Response.json(freshAccount(SOURCE))] });
  await analyze();
  await screen.findByTestId("busy-retry");
  cleanup();
  await pause(1_300);
  expect(seen.account).toBe(1);
});

async function proceed(): Promise<void> {
  useDemolishStore.setState({ destinationAddress: DEST, destinationAcknowledgedFor: DEST });
  await act(async () => {
    render(
      <PlanView
        account={freshAccount(SOURCE)}
        conversions={[]}
        claimableBalanceDecisions={[]}
        blockers={[]}
        planFeeStroops={null}
        network="testnet"
        onRefresh={() => {}}
        loading={false}
      />
    );
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /review the full plan/i }));
  });
}

test("a busy destination check is asked again on its own and the close goes on to review", async () => {
  const seen = stubFetch({
    check: [() => busy("0"), () => Response.json({ requiresMediator: false, available: true })],
  });
  await proceed();
  await waitFor(() => expect(useDemolishStore.getState().phase).toBe("PREFLIGHT_COMPLETE"));
  expect(seen.check).toBe(2);
  expect(seen.plan).toBe(1);
});

test("a busy final plan is asked again on its own and the close goes on to review", async () => {
  const seen = stubFetch({ plan: [() => busy("0"), () => Response.json(PLAN)] });
  await proceed();
  await waitFor(() => expect(useDemolishStore.getState().phase).toBe("PREFLIGHT_COMPLETE"));
  expect(seen.plan).toBe(2);
});

test("the close transactions are never asked for again after a busy answer", async () => {
  const seen = stubFetch({ tx: [() => busy("0")] });
  await expect(
    fetchCloseTransactions({ source: SOURCE, destination: DEST } as never, "testnet")
  ).rejects.toBeInstanceOf(ApiRequestError);
  expect(seen.tx).toBe(1);
});

function reviewed(): void {
  const store = useDemolishStore.getState();
  store.setAddresses(SOURCE, DEST);
  store.setPlan([STEP], PLAN.planHash, 1);
  store.setPhase("PREFLIGHT_COMPLETE");
  store.setAccountState(freshAccount(SOURCE));
  useDemolishStore.setState({
    planSignature: signatureOf(PLAN, freshAccount(SOURCE), useDemolishStore.getState()),
  });
}

test("a review check whose account read is busy once asks again on its own and moves on", async () => {
  reviewed();
  const seen = stubFetch({ account: [() => busy("0"), () => Response.json(freshAccount(SOURCE))] });
  expect(await refreshReviewedPlan("testnet")).toEqual({ kind: "unchanged" });
  expect(seen).toMatchObject({ account: 2, plan: 1 });
});

test("a review check whose plan is busy twice fails busy and ends the account read's wait", async () => {
  reviewed();
  const seen = stubFetch({ account: [() => busy("30")], plan: [() => busy("0")] });
  const waits: (number | null)[][] = [];
  const outcome = await refreshReviewedPlan("testnet", undefined, {
    reporter: () => {
      const mine: (number | null)[] = [];
      waits.push(mine);
      return (s) => void mine.push(s);
    },
  });
  expect(outcome.kind).toBe("failed");
  expect((outcome as { message: string }).message).toContain(REFRESH_BUSY_COPY);
  await pause(10);
  expect(seen).toMatchObject({ account: 1, plan: 2 });
  expect(waits.every((w) => w.at(-1) === null)).toBe(true);
});

test("stopping the review's wait reports the busy answer, never the connection", async () => {
  reviewed();
  const seen = stubFetch({ account: [() => busy("30")] });
  await act(async () => {
    render(<ReviewView network="testnet" />);
  });
  fireEvent.click(screen.getByRole("checkbox"));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /continue to signing/i }));
  });
  await act(async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Stop waiting" }));
  });
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain(REFRESH_BUSY_COPY);
  expect(alert.textContent).toContain("Try again in about 30 seconds.");
  expect(alert.textContent).not.toContain("Check your connection");
  expect(seen.account).toBe(1);
  expect(pushed).toEqual([]);
});
