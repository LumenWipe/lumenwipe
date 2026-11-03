import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Suspense } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import * as navigation from "next/navigation";
import HomePage from "@/app/[network]/page";
import * as sessionRecovery from "@/hooks/useSessionRecovery";
import * as sessionStore from "@/lib/session/store";
import * as submitViaApi from "@/lib/stellar/submit-via-api";
import { CLOSE_FINISHED_NOTICE, STILL_UNCONFIRMED_NOTICE } from "@/lib/utils/user-error";
import type { SessionRecord } from "@/types/session";

const HASH = "a".repeat(64);
const SESSION = {
  id: "s",
  network: "testnet",
  sourceAddress: "GAAAAAAAAAAAAAAAA",
  destinationAddress: "GBBBBBBBBBBBBBBBB",
  memo: null,
  completedSteps: [],
  currentStepIndex: 0,
  stepCount: 2,
  stepBase: 0,
  createdAt: "2026-10-01T00:00:00.000Z",
  unconfirmed: { hash: HASH, covers: ["MERGE"], validUntil: 1000 },
} as unknown as SessionRecord;

let submit: ReturnType<typeof spyOn>;
let clearSession: ReturnType<typeof mock>;

beforeEach(() => {
  spyOn(navigation, "useRouter").mockImplementation(
    () => ({ push: () => {}, replace: () => {} }) as never
  );
  spyOn(navigation, "useSearchParams").mockImplementation(() => new URLSearchParams() as never);
  clearSession = mock(() => {});
  spyOn(sessionRecovery, "useSessionRecovery").mockImplementation(() => ({
    session: SESSION,
    checked: true,
    clearSession,
    reload: async () => {},
  }));
  spyOn(sessionStore, "deleteSession").mockImplementation(async () => {});
  spyOn(sessionStore, "clearUnconfirmedFor").mockImplementation(async () => {});
  submit = spyOn(submitViaApi, "submitViaApi");
});

afterEach(() => mock.restore());

async function renderHome(): Promise<void> {
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <HomePage params={Promise.resolve({ network: "testnet" })} />
      </Suspense>
    );
  });
}

test("a restored session with an unconfirmed hash offers a check, no resume and no dismiss", async () => {
  await renderHome();
  const banner = screen.getByRole("button", { name: "Check again" }).parentElement!;
  expect(banner.querySelectorAll("button")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Resume this close" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Discard this record" })).toBeNull();
});

test("a confirmed merge finishes the session by lookup and sends nothing", async () => {
  spyOn(submitViaApi, "lookupViaApi").mockImplementation(async () => ({
    status: "confirmed",
    hash: HASH,
    ledger: 1,
  }));
  await renderHome();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  });
  expect(screen.getByRole("status").textContent).toBe(CLOSE_FINISHED_NOTICE);
  expect(clearSession).toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
});

test("a lookup that fails stays unconfirmed", async () => {
  spyOn(submitViaApi, "lookupViaApi").mockImplementation(async () => {
    throw new Error("503");
  });
  await renderHome();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  });
  expect(screen.getByRole("status").textContent).toBe(STILL_UNCONFIRMED_NOTICE);
  expect(screen.getByRole("button", { name: "Check again" })).toBeDefined();
  expect(clearSession).not.toHaveBeenCalled();
});

test("a hash that appeared after the banner loaded stops the dismiss and is read back", async () => {
  const reload = mock(async () => {});
  spyOn(sessionRecovery, "useSessionRecovery").mockImplementation(() => ({
    session: { ...SESSION, unconfirmed: undefined },
    checked: true,
    clearSession,
    reload,
  }));
  spyOn(sessionStore, "deleteSettledSession").mockImplementation(async () => false);
  await renderHome();
  fireEvent.click(screen.getByRole("button", { name: "Discard this record" }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
  });
  expect(clearSession).not.toHaveBeenCalled();
  expect(reload).toHaveBeenCalledTimes(1);
});
