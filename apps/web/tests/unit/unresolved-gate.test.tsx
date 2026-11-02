import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { Suspense } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";
import * as navigation from "next/navigation";
import NetworkLayout from "@/app/[network]/layout";
import AccountEntryForm from "@/components/account-entry/AccountEntryForm";
import * as statsHook from "@/hooks/useStats";
import * as walletConnection from "@/hooks/useWalletKitConnection";
import * as recovery from "@/lib/session/recovery";
import * as sessionStore from "@/lib/session/store";
import * as submitViaApi from "@/lib/stellar/submit-via-api";
import { useDemolishStore } from "@/store/demolish";
import { useNetworkStore } from "@/store/network";
import type { SessionRecord } from "@/types/session";

const SOURCE = Keypair.random().publicKey();
const HASH = "a".repeat(64);
const HELD = {
  id: "s",
  network: "testnet",
  sourceAddress: SOURCE,
  unconfirmed: { hash: HASH, covers: ["MERGE"], validUntil: 1000 },
} as unknown as SessionRecord;

let push: ReturnType<typeof mock>;

function route(pathname: string, query = ""): void {
  spyOn(navigation, "usePathname").mockReturnValue(pathname);
  spyOn(navigation, "useSearchParams").mockReturnValue(new URLSearchParams(query) as never);
}

async function renderPage(): Promise<void> {
  const params = Object.assign(Promise.resolve({ network: "testnet" }), {
    status: "fulfilled",
    value: { network: "testnet" },
  });
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <NetworkLayout params={params}>
          <button>Sign</button>
        </NetworkLayout>
      </Suspense>
    );
  });
}

beforeEach(() => {
  push = mock(() => {});
  spyOn(navigation, "useRouter").mockImplementation(() => ({ push, replace: () => {} }) as never);
  spyOn(sessionStore, "clearUnconfirmedFor").mockImplementation(async () => {});
  spyOn(sessionStore, "deleteSession").mockImplementation(async () => {});
  spyOn(recovery, "findUnresolved").mockImplementation(async () => HELD);
  spyOn(statsHook, "useStats").mockReturnValue({ stats: null, stale: false } as never);
  useNetworkStore.setState({ network: "testnet" });
  useDemolishStore.setState({ sourceAddress: null, unconfirmedSubmission: null });
});

afterEach(() => {
  cleanup();
  mock.restore();
});

test("a deep link to /analyze for the account offers only the lookup", async () => {
  route("/testnet/analyze", `source=${SOURCE}`);
  await renderPage();
  expect(screen.queryByRole("button", { name: "Sign" })).toBeNull();
  expect(screen.getByTestId("unconfirmed-panel").textContent).toContain(HASH);
});

test("/review and /execute are held for the account in the store", async () => {
  useDemolishStore.setState({ sourceAddress: SOURCE });
  for (const page of ["review", "execute"]) {
    route(`/testnet/${page}`);
    await renderPage();
    expect(screen.queryByRole("button", { name: "Sign" })).toBeNull();
    cleanup();
  }
});

test("another account is not held", async () => {
  spyOn(recovery, "findUnresolved").mockImplementation(async () => null);
  route("/testnet/analyze", "source=GOTHER");
  await renderPage();
  expect(screen.getByRole("button", { name: "Sign" })).toBeDefined();
});

test("a home page is not held: the banner offers the lookup there", async () => {
  useDemolishStore.setState({ sourceAddress: SOURCE });
  route("/testnet");
  await renderPage();
  expect(screen.getByRole("button", { name: "Sign" })).toBeDefined();
});

test("a lookup past the deadline releases the page and clears the record", async () => {
  route("/testnet/analyze", `source=${SOURCE}`);
  spyOn(submitViaApi, "lookupViaApi").mockImplementation(
    async () =>
      ({
        status: "not_found",
        hash: HASH,
        searched: {
          oldestLedger: 1,
          oldestLedgerCloseTime: 1,
          latestLedger: 2,
          latestLedgerCloseTime: 2_000_000_000,
        },
      }) as never
  );
  await renderPage();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  });
  expect(screen.getByRole("button", { name: "Sign" })).toBeDefined();
  expect(sessionStore.clearUnconfirmedFor).toHaveBeenCalledWith("testnet", SOURCE);
});

test("a lookup that says nothing keeps the page held", async () => {
  route("/testnet/analyze", `source=${SOURCE}`);
  spyOn(submitViaApi, "lookupViaApi").mockImplementation(async () => {
    throw new Error("503");
  });
  await renderPage();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  });
  expect(screen.queryByRole("button", { name: "Sign" })).toBeNull();
  expect(sessionStore.clearUnconfirmedFor).not.toHaveBeenCalled();
});

test("a confirmed merge ends the close there and offers nothing to sign", async () => {
  route("/testnet/analyze", `source=${SOURCE}`);
  spyOn(submitViaApi, "lookupViaApi").mockImplementation(
    async () => ({ status: "confirmed", hash: HASH, ledger: 1 }) as never
  );
  await renderPage();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  });
  expect(screen.queryByRole("button", { name: "Sign" })).toBeNull();
  expect(sessionStore.deleteSession).toHaveBeenCalledWith("s");
});

test("the entry form sends a held account to the gate without reading it", async () => {
  route("/testnet");
  spyOn(walletConnection, "useWalletKitConnection").mockImplementation(
    () => ({ address: SOURCE, networkMismatch: false }) as never
  );
  const fetched = spyOn(globalThis, "fetch");
  render(<AccountEntryForm />);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /analy/i }));
  });
  expect(push).toHaveBeenCalledWith(`/testnet/analyze?source=${SOURCE}`);
  expect(fetched).not.toHaveBeenCalled();
});
