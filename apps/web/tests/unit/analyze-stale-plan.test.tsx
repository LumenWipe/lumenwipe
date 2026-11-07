import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";
import * as navigation from "next/navigation";
import AnalyzePage from "@/app/[network]/analyze/page";
import { useDemolishStore } from "@/store/demolish";
import { useNetworkStore } from "@/store/network";
import { freshAccount, freshPlan } from "./fixtures/fresh-plan";

const SOURCE = Keypair.random().publicKey();
const STALE = "The plan below may not reflect your last answer";

function settled<T>(value: T): Promise<T> {
  return Object.assign(Promise.resolve(value), { status: "fulfilled", value });
}

/** Answers every account read, and each plan request with the next of `plans`. */
function stubFetch(plans: Array<() => Response>): { planCalls: () => number } {
  let calls = 0;
  spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/close/plan")) {
      const next = plans[Math.min(calls, plans.length - 1)]!;
      calls++;
      return next();
    }
    if (url.includes("/account/")) {
      return Response.json(freshAccount(SOURCE));
    }
    return Response.json({});
  }) as unknown as typeof fetch);
  return { planCalls: () => calls };
}

const ok = () => Response.json(freshPlan([]));
const down = () =>
  Response.json({ error: { code: "internal_error", message: "x" } }, { status: 500 });

function proceedButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /review the full plan/i }) as HTMLButtonElement;
}

function reasons(): string {
  return screen.getByRole("list", { name: "Before you can review" }).textContent ?? "";
}

async function analyzeThenReplan(plans: Array<() => Response>) {
  const fetched = stubFetch(plans);
  await act(async () => {
    render(<AnalyzePage params={settled({ network: "testnet" as const })} />);
  });
  await screen.findByRole("heading", { name: "Decide what happens to each item" });
  // Any answer the plan is requested with re-plans the page.
  await act(async () => {
    useDemolishStore.getState().acknowledgeDefiPositions(SOURCE);
  });
  return fetched;
}

beforeEach(() => {
  useNetworkStore.setState({ network: "testnet" });
  useDemolishStore.getState().reset();
  const params = new URLSearchParams(`source=${SOURCE}`);
  spyOn(navigation, "useRouter").mockImplementation(
    () =>
      ({ push: () => {}, replace: () => {} }) as unknown as ReturnType<typeof navigation.useRouter>
  );
  spyOn(navigation, "useSearchParams").mockImplementation(
    () => params as unknown as ReturnType<typeof navigation.useSearchParams>
  );
});

afterEach(() => mock.restore());

test("a failed re-plan says the plan may be stale, offers Retry, and holds the review", async () => {
  const fetched = await analyzeThenReplan([ok, down, ok]);

  const banner = await screen.findByTestId("stale-plan");
  expect(banner.textContent).toContain(STALE);
  expect(banner.getAttribute("role")).toBe("alert");
  expect(screen.getByRole("button", { name: "Retry" })).toBeDefined();
  expect(proceedButton().disabled).toBe(true);
  expect(reasons()).toContain(STALE);

  const before = fetched.planCalls();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  });

  await waitFor(() => expect(screen.queryByRole("button", { name: "Retry" })).toBeNull());
  expect(fetched.planCalls()).toBe(before + 1);
  expect(screen.queryByTestId("stale-plan")).toBeNull();
  expect(reasons()).not.toContain(STALE);
});

test("a retry that fails again keeps the plan held", async () => {
  await analyzeThenReplan([ok, down]);
  await screen.findByTestId("stale-plan");

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  });

  await waitFor(() => expect(screen.getByRole("button", { name: "Retry" })).toBeDefined());
  expect(reasons()).toContain(STALE);
  expect(proceedButton().disabled).toBe(true);
});

test("a first load that works shows no stale banner", async () => {
  stubFetch([ok]);
  await act(async () => {
    render(<AnalyzePage params={settled({ network: "testnet" as const })} />);
  });
  await screen.findByRole("heading", { name: "Decide what happens to each item" });
  expect(screen.queryByTestId("stale-plan")).toBeNull();
});

test("Retry is held while the plan it asked for is being fetched", async () => {
  const pending = () => new Promise<Response>(() => {}) as unknown as Response;
  await analyzeThenReplan([ok, down, pending]);
  await screen.findByTestId("stale-plan");

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  });

  expect((screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement).disabled).toBe(true);
});

test("Retry is held while a refresh of the account runs", async () => {
  const pending = () => new Promise<Response>(() => {}) as unknown as Response;
  await analyzeThenReplan([ok, down, pending]);
  await screen.findByTestId("stale-plan");

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Refresh the plan" }));
  });

  expect((screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement).disabled).toBe(true);
});
