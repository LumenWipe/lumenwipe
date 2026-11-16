import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";
import * as navigation from "next/navigation";
import AnalyzePage from "@/app/[network]/analyze/page";
import UnresolvedGate from "@/components/execution/UnresolvedGate";
import AccountEntryForm from "@/components/account-entry/AccountEntryForm";
import * as walletConnection from "@/hooks/useWalletKitConnection";
import * as recovery from "@/lib/session/recovery";
import * as sessionStore from "@/lib/session/store";
import * as submitViaApi from "@/lib/stellar/submit-via-api";
import { useDemolishStore } from "@/store/demolish";
import { useNetworkStore } from "@/store/network";
import type { AccountState } from "@/types/account";
import type { SessionRecord } from "@/types/session";
import { emptyDefiPositionsResult } from "./fixtures/defi-positions";
import { expectFocusedNow, expectSameElement } from "./fixtures/focus";
import { installIndexedDb, removeIndexedDb } from "./fixtures/indexed-db";

const SOURCE = Keypair.random().publicKey();
const BALANCE = "00000000b1";
const NOT_FOUND = "couldn't find that on this network";
const params = Object.assign(Promise.resolve({ network: "testnet" as const }), {
  status: "fulfilled",
  value: { network: "testnet" as const },
});

function account(): AccountState {
  return {
    address: SOURCE,
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
    claimableBalances: [
      { id: BALANCE, asset: "native", amount: "1.0000000", claimants: [], sponsor: null },
    ],
    subEntryMismatch: false,
    defiPositions: emptyDefiPositionsResult(SOURCE),
    defiPositionsWarnings: [],
  } as AccountState;
}

const planBody = {
  status: "needs_decisions",
  blockers: [],
  steps: [],
  decisionPoints: [
    {
      id: `claim:${BALANCE}`,
      type: "claimable_balance",
      subject: {
        kind: "claimable_balance",
        balanceId: BALANCE,
        asset: "native",
        amount: "1.0000000",
        currentlyClaimable: true,
      },
      options: [{ id: "claim", recommended: true }, { id: "forfeit" }],
      default: "claim",
      required: true,
    },
  ],
};

let push: ReturnType<typeof mock>;

interface Requests {
  account: number;
  plan: string[];
}

function stubFetch(
  answers: {
    account?: () => Response | Promise<Response>;
    plan?: () => Response | Promise<Response>;
  } = {}
): Requests {
  const seen: Requests = { account: 0, plan: [] };
  spyOn(globalThis, "fetch").mockImplementation((async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/close/plan")) {
      seen.plan.push(String(init?.body));
      return answers.plan ? answers.plan() : Response.json(planBody);
    }
    if (url.includes("/account/")) {
      seen.account++;
      return answers.account ? answers.account() : Response.json(account());
    }
    return Response.json({});
  }) as unknown as typeof fetch);
  return seen;
}

const notFound = (): Response =>
  Response.json({ error: { code: "account_not_found", message: "raw" } }, { status: 404 });

const FORFEIT = { name: /^Leave it unclaimed/ };
const forfeitOption = (): HTMLElement => screen.getByRole("radio", FORFEIT);
const findForfeitOption = (): Promise<HTMLElement> => screen.findByRole("radio", FORFEIT);

async function mountPage(): Promise<void> {
  await act(async () => {
    render(<AnalyzePage params={params} />);
  });
}

beforeEach(() => {
  installIndexedDb();
  useDemolishStore.getState().reset();
  useNetworkStore.setState({ network: "testnet" });
  push = mock(() => {});
  const router = { push, replace: () => {} };
  spyOn(navigation, "useRouter").mockImplementation(() => router as never);
  spyOn(navigation, "useSearchParams").mockImplementation(
    () => new URLSearchParams(`source=${SOURCE}`) as never
  );
});

afterEach(() => {
  cleanup();
  mock.restore();
  removeIndexedDb();
});

test("an account with a claimable balance is read once and planned once", async () => {
  const seen = stubFetch();
  await mountPage();
  await waitFor(() => expect(forfeitOption()).toBeTruthy());
  await act(async () => {});
  expect(useDemolishStore.getState().claimableBalanceSelections[BALANCE]).toBe("claim");
  expect(seen).toEqual({ account: 1, plan: [expect.any(String)] });
});

test("Strict Mode's double mount still reads and plans once", async () => {
  const seen = stubFetch();
  await act(async () => {
    render(
      <StrictMode>
        <AnalyzePage params={params} />
      </StrictMode>
    );
  });
  await findForfeitOption();
  await act(async () => {});
  expect(seen).toEqual({ account: 1, plan: [expect.any(String)] });
});

test("answering a claim card asks for one plan and no account read", async () => {
  const seen = stubFetch();
  await mountPage();
  const box = await findForfeitOption();
  await act(async () => {
    fireEvent.click(box);
  });
  await waitFor(() => expect(seen.plan.length).toBe(2));
  expect(seen.account).toBe(1);
  expect(seen.plan[1]).toContain("forfeit");

  await act(async () => {
    fireEvent.click(screen.getByRole("radio", { name: /^Claim it/ }));
  });
  await waitFor(() => expect(seen.plan.length).toBe(3));
  expect(seen.account).toBe(1);
});

test("the chosen claim option keeps its node and focus through the re-plan it starts", async () => {
  const seen = stubFetch();
  await mountPage();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Claim balances/ }));
  });
  const forfeit = await findForfeitOption();
  forfeit.focus();
  await act(async () => {
    fireEvent.click(forfeit);
  });
  await waitFor(() => expect(seen.plan.length).toBe(2));
  await screen.findByText("Plan updated");

  expectSameElement(forfeitOption(), forfeit);
  expect(forfeit.isConnected).toBe(true);
  expect((forfeit as HTMLInputElement).checked).toBe(true);
  expectFocusedNow(forfeit);
});

test("a DeFi acknowledgement re-plans with no account read", async () => {
  const seen = stubFetch();
  await mountPage();
  await findForfeitOption();
  await act(async () => {
    useDemolishStore.getState().acknowledgeDefiPositions(SOURCE);
  });
  await waitFor(() => expect(seen.plan.length).toBe(2));
  expect(seen.account).toBe(1);
});

test("the refresh button still reads the account again", async () => {
  const seen = stubFetch();
  await mountPage();
  await findForfeitOption();
  const refresh = document.querySelector("svg.lucide-refresh-cw")?.closest("button");
  await act(async () => {
    fireEvent.click(refresh as HTMLButtonElement);
  });
  await waitFor(() => expect(seen.account).toBe(2));
  expect(seen.plan.length).toBe(2);
});

test("a re-plan carries the tokens the account read found, in one request", async () => {
  const contract = "CTOKEN";
  const seen = stubFetch({
    account: () =>
      Response.json({
        ...account(),
        sorobanTokens: { tokens: [{ contract, balance: "1", symbol: "T", decimals: 7 }] },
      }),
    plan: () =>
      Response.json({
        ...planBody,
        decisionPoints: [
          ...planBody.decisionPoints,
          { id: "t", type: "choice", subject: { kind: "soroban_token", contract }, options: [] },
        ],
      }),
  });
  await mountPage();
  const box = await findForfeitOption();
  await act(async () => {
    fireEvent.click(box);
  });
  await waitFor(() => expect(seen.plan.length).toBe(2));
  expect(seen.plan[1]).toContain(contract);
});

test.each([
  ["plan", true],
  ["account", false],
])(
  "a nonexistent account shows one entry-flow error when the %s answers first",
  async (_, planFirst) => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const seen = stubFetch({
      plan: async () => {
        if (!planFirst) await held;
        return notFound();
      },
      account: async () => {
        if (planFirst) await held;
        return notFound();
      },
    });
    await mountPage();
    await act(async () => {
      release();
    });
    await waitFor(() => expect(screen.getAllByRole("alert").length).toBe(1));
    expect(screen.getByRole("alert").textContent).toContain(NOT_FOUND);
    expect(seen).toEqual({ account: 1, plan: [expect.any(String)] });
  }
);

test("a dropped connection reads as a connection problem", async () => {
  stubFetch({ account: () => Promise.reject(new Error("net::ERR_FAILED")) });
  await mountPage();
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Failed to connect to the Stellar network"
  );
});

test("the entry form reads no account and persists nothing for a mistyped address", async () => {
  spyOn(recovery, "findUnresolved").mockImplementation(async () => null);
  spyOn(walletConnection, "useWalletKitConnection").mockImplementation(
    () => ({ address: SOURCE, status: "connected", network: "yes", verified: true }) as never
  );
  const saved = spyOn(sessionStore, "saveSession").mockImplementation(async () => {});
  const seen = stubFetch({ account: notFound, plan: notFound });

  render(<AccountEntryForm />);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /analy/i }));
  });
  expect(push).toHaveBeenCalledWith(`/testnet/analyze?source=${SOURCE}`);
  expect(seen.account).toBe(0);
  cleanup();

  await mountPage();
  await screen.findByRole("alert");
  expect(saved).not.toHaveBeenCalled();
});

const HELD = {
  id: "s",
  network: "testnet",
  sourceAddress: SOURCE,
  unconfirmed: { hash: "a".repeat(64), covers: ["MERGE"], validUntil: 1000 },
} as unknown as SessionRecord;

async function mountGated(): Promise<void> {
  await act(async () => {
    render(
      <UnresolvedGate network="testnet" source={SOURCE}>
        <AnalyzePage params={params} />
      </UnresolvedGate>
    );
  });
}

test("a held account issues no account or plan request", async () => {
  spyOn(recovery, "findUnresolved").mockImplementation(async () => HELD);
  const seen = stubFetch();
  await mountGated();
  expect(screen.getByTestId("unconfirmed-panel")).toBeTruthy();
  expect(seen).toEqual({ account: 0, plan: [] });
});

test("a released account is read once the gate opens, and only then", async () => {
  spyOn(recovery, "findUnresolved").mockImplementation(async () => HELD);
  spyOn(sessionStore, "clearUnconfirmedFor").mockImplementation(async () => {});
  spyOn(submitViaApi, "lookupViaApi").mockImplementation(
    async () =>
      ({
        status: "not_found",
        hash: HELD.unconfirmed?.hash,
        searched: {
          oldestLedger: 1,
          oldestLedgerCloseTime: 1,
          latestLedger: 2,
          latestLedgerCloseTime: 2_000_000_000,
        },
      }) as never
  );
  const seen = stubFetch();
  await mountGated();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  });
  await waitFor(() => expect(seen.account).toBe(1));
  expect(seen.plan.length).toBe(1);
});
