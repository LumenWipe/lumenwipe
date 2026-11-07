import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act, render, screen } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";
import * as navigation from "next/navigation";
import ReviewView from "@/components/review/ReviewView";
import { Account, MuxedAccount } from "@stellar/stellar-sdk";
import { activeRegistry, setRegistry } from "@/lib/exchange-registry";
import { useDemolishStore } from "@/store/demolish";
import { useNetworkStore } from "@/store/network";
import type { PlannedStep } from "@/types/plan";

const SOURCE = Keypair.random().publicKey();
const DEST = Keypair.random().publicKey();
const EXCHANGE = activeRegistry().entries.find((e) => e.requiresMediator && e.requiresMemo)!;

const MERGE: PlannedStep = {
  index: 0,
  type: "MERGE",
  title: "Merge account",
  description: "",
  operationCount: 1,
  estimatedFeeLumens: "0.0000100",
  txXdr: null,
  status: "pending",
  txHash: null,
  error: null,
};

beforeEach(() => {
  spyOn(navigation, "useRouter").mockImplementation(
    () =>
      ({ push: () => {}, replace: () => {} }) as unknown as ReturnType<typeof navigation.useRouter>
  );
  useNetworkStore.setState({ network: "testnet" });
  useDemolishStore.getState().reset();
  useDemolishStore.getState().setPlan([MERGE]);
  useDemolishStore.getState().setPhase("PREFLIGHT_COMPLETE");
});

afterEach(() => mock.restore());

async function show(): Promise<HTMLElement> {
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(<ReviewView network="testnet" />));
  });
  return container;
}

function memoText(): string {
  return screen.getByTestId("memo-line").textContent ?? "";
}

function kindText(): string {
  return screen.getByTestId("destination-kind").textContent ?? "";
}

test("the hero is the first thing on the review and holds both full addresses", async () => {
  useDemolishStore.getState().setAddresses(SOURCE, DEST);
  const container = await show();
  const hero = screen.getByTestId("review-hero");
  expect(container.firstElementChild?.firstElementChild).toBe(hero);
  const groups = [...hero.querySelectorAll('[aria-hidden="true"]')].map((g) => g.textContent);
  expect(groups).toContain(SOURCE);
  expect(groups).toContain(DEST);
});

test("the memo row says none when no memo is set", async () => {
  useDemolishStore.getState().setAddresses(SOURCE, DEST);
  await show();
  expect(memoText()).toBe("none");
});

test("a text memo is shown as stored, verbatim, with its byte count", async () => {
  useDemolishStore.getState().setAddresses(SOURCE, DEST, "deposit  42", "text");
  await show();
  const stored = useDemolishStore.getState().memo;
  expect(memoText()).toBe(`text: ${stored} (11 bytes)`);
  expect(memoText()).not.toContain("…");
});

test("an id memo is shown as stored", async () => {
  useDemolishStore.getState().setAddresses(SOURCE, DEST, "7", "id");
  await show();
  expect(memoText()).toBe(`id: ${useDemolishStore.getState().memo}`);
});

test("a hash memo is shown in full", async () => {
  const hash = "0f".repeat(32);
  useDemolishStore.getState().setAddresses(SOURCE, DEST, hash, "hash");
  await show();
  expect(memoText()).toBe(`hash: ${hash}`);
});

test("a listed exchange takes the registry's memo type, as the signed memo does", async () => {
  const type = EXCHANGE.memoType;
  useDemolishStore.getState().setAddresses(SOURCE, EXCHANGE.address, "123", "text");
  useDemolishStore.getState().setMediatorRequired(true);
  await show();
  expect(memoText().startsWith(`${type}: 123`)).toBe(true);
});

test("a recognized exchange is named, with its memo rule, the relay account and the list date", async () => {
  useDemolishStore.getState().setAddresses(SOURCE, EXCHANGE.address, "123");
  useDemolishStore.getState().setMediatorRequired(true);
  await show();
  expect(kindText()).toBe(
    `Recognized exchange: ${EXCHANGE.name}, deposit memo required, sent through LumenWipe's shared relay account within the same close.`
  );
  expect(screen.getByText(/Exchange list last checked/).textContent).toBe(
    `Exchange list last checked ${activeRegistry().lastVerified.slice(0, 10)}.`
  );
  expect(screen.getByText(/Exchange list last checked/).textContent).toMatch(
    /checked \d{4}-\d{2}-\d{2}\.$/
  );
});

test("a destination the user confirmed is echoed with the warning they accepted", async () => {
  useDemolishStore.getState().setAddresses(SOURCE, DEST);
  useDemolishStore.getState().acknowledgeDestination(DEST);
  await show();
  expect(kindText()).toBe(
    "A wallet you confirmed you control. If this is an exchange, the funds will be lost."
  );
  expect(screen.queryByText(/Exchange list last checked/)).toBeNull();
});

test("a plain wallet makes no claim of a confirmation and warns it is not recognized", async () => {
  useDemolishStore.getState().setAddresses(SOURCE, DEST);
  await show();
  expect(kindText()).not.toMatch(/confirm/i);
  expect(kindText()).not.toMatch(/you control/i);
  expect(kindText()).toMatch(/does not recognize this address as an exchange/);
  expect(kindText()).toMatch(/funds will be lost/);
});

test("the destination is shown whole and in the same groups everywhere on the review", async () => {
  useDemolishStore.getState().setAddresses(SOURCE, DEST);
  const container = await show();
  const shown = [...container.querySelectorAll('[aria-hidden="true"]')].filter(
    (g) => g.textContent === DEST
  );
  expect(shown.length).toBeGreaterThanOrEqual(3);
  expect(new Set(shown.map((g) => g.innerHTML)).size).toBe(1);
  // The consent sentence alone names it short, with the whole address directly above it.
  const consent = screen.getByTestId("review-consent-row");
  expect(consent.previousElementSibling?.textContent).toContain(DEST);
  const text = (container.textContent ?? "").replace(consent.textContent ?? "", "");
  for (const cut of [`${DEST.slice(0, 4)}…`, `${DEST.slice(0, 8)}…`, `${DEST.slice(0, 8)}...`]) {
    expect(text).not.toContain(cut);
  }
});

test("the account counts are shown open", async () => {
  useDemolishStore.getState().setAddresses(SOURCE, DEST);
  useDemolishStore.setState({
    accountState: {
      address: SOURCE,
      trustlines: [],
      claimableBalances: [],
      openOffers: [],
      dataEntries: [],
      signers: [],
      defiPositions: { positions: [], unrecognizedPositions: [], source: "lumenwipe" },
    } as never,
  });
  await show();
  const details = screen.getByText("What is on this account").closest("details")!;
  expect(details.open).toBe(true);
  expect(details.textContent).toContain("Trustlines");
});

test("the relay is said from the registry, not from the stored flag", async () => {
  useDemolishStore.getState().setAddresses(SOURCE, EXCHANGE.address, "123");
  useDemolishStore.getState().setMediatorRequired(false);
  await show();
  expect(kindText()).toContain("sent through LumenWipe's shared relay account");
  expect(screen.getByText(/routed through the shared relay account/)).toBeDefined();
});

test("a stored relay flag does not make a wallet close go through the relay", async () => {
  useDemolishStore.getState().setAddresses(SOURCE, DEST);
  useDemolishStore.getState().setMediatorRequired(true);
  const container = await show();
  expect(container.textContent).not.toContain("relay account");
});

test("an exchange the registry asks the relay for but cannot vouch for is not called direct", async () => {
  const before = activeRegistry();
  const unbacked = Keypair.random().publicKey();
  setRegistry({
    ...before,
    entries: [
      ...before.entries,
      {
        address: unbacked,
        name: "Served",
        domain: "example.com",
        requiresMediator: true,
        requiresMemo: true,
        memoType: "text",
      },
    ],
  });
  try {
    useDemolishStore.getState().setAddresses(SOURCE, unbacked, "123");
    useDemolishStore.getState().setMediatorRequired(false);
    await show();
    expect(kindText()).not.toContain("sent straight to the exchange");
    expect(kindText()).toContain("this close will not be signed");
  } finally {
    setRegistry(before);
  }
});

test("a muxed address of a listed exchange keeps the not-recognized line", async () => {
  const muxed = new MuxedAccount(new Account(EXCHANGE.address, "0"), "42").accountId();
  useDemolishStore.getState().setAddresses(SOURCE, muxed);
  await show();
  expect(kindText()).toBe(
    "LumenWipe does not recognize this address as an exchange. If it is one, the funds will be lost."
  );
});

test("direction overrides and zero-width characters in a text memo are shown, not applied", async () => {
  const memo = "ab\u202Ecd\u200Bef";
  useDemolishStore.getState().setAddresses(SOURCE, DEST, memo, "text");
  await show();
  const line = screen.getByTestId("memo-line");
  expect(line.textContent).toBe("text: ab\\u{202E}cd\\u{200B}ef (12 bytes)");
  expect(line.textContent).not.toContain("\u202E");
  expect(line.textContent).not.toContain("\u200B");
  expect(line.querySelector("bdi")).not.toBeNull();
  expect(
    [...line.querySelectorAll('[data-testid="memo-escape"]')].map((e) => e.textContent)
  ).toEqual(["\\u{202E}", "\\u{200B}"]);
});
