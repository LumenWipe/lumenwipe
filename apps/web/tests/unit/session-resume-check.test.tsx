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
  }));
  spyOn(sessionStore, "deleteSession").mockImplementation(async () => {});
  spyOn(sessionStore, "saveUnconfirmed").mockImplementation(async () => {});
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

test("a restored session with an unconfirmed hash offers a check, not a resume", async () => {
  await renderHome();
  expect(screen.getByRole("button", { name: "Check again" })).toBeDefined();
  expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
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
