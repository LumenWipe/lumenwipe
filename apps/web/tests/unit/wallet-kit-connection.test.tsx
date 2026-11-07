import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import { KitEventType } from "@creit-tech/stellar-wallets-kit/types";
import * as walletKitClient from "@/lib/wallet-kit/client";
import {
  RECHECK_INTERVAL_MS,
  useWalletKitConnection,
  type WalletKitConnection,
} from "@/hooks/useWalletKitConnection";
import WalletConnectPanel, { NO_WALLET_CONNECT_NOTE } from "@/components/wallet/WalletConnectPanel";
import { WalletNotUsableError } from "@/lib/stellar/signer";
import { VARIAL_ID } from "@creit-tech/stellar-wallets-kit/modules/varial";

const saved = Keypair.random().publicKey();
const other = Keypair.random().publicKey();

type StateListener = (event: { payload: { address: string | undefined } }) => void;

/** A stand-in for the kit's static singleton: what it saved, and what the wallet answers. */
let kit: {
  saved: string | null;
  network: { networkPassphrase: string } | Error;
  stateListeners: StateListener[];
  authModal: ReturnType<typeof mock>;
  fetchAddress: ReturnType<typeof mock>;
};
let silentAnswer: string | null | "unsupported";
let lookups: ReturnType<typeof mock>;

function installKit(): void {
  kit = {
    saved,
    network: { networkPassphrase: Networks.TESTNET },
    stateListeners: [],
    authModal: mock(async () => ({ address: saved })),
    fetchAddress: mock(async () => ({ address: saved })),
  };
  const fake = {
    getAddress: async () => {
      if (!kit.saved) throw { code: -1, message: "No wallet has been connected." };
      return { address: kit.saved };
    },
    getNetwork: async () => {
      if (kit.network instanceof Error) throw kit.network;
      return { network: "", ...kit.network };
    },
    authModal: (...args: unknown[]) => kit.authModal(...args),
    fetchAddress: (...args: unknown[]) => kit.fetchAddress(...args),
    disconnect: async () => {},
    on: (type: KitEventType, listener: StateListener) => {
      if (type === KitEventType.STATE_UPDATED) {
        // The kit reports its saved address once, synchronously, on subscribing.
        listener({ payload: { address: kit.saved ?? undefined } });
        kit.stateListeners.push(listener);
      }
      return () => {};
    },
  };
  spyOn(walletKitClient, "ensureWalletKitInitialized").mockImplementation(
    () => fake as unknown as ReturnType<typeof walletKitClient.ensureWalletKitInitialized>
  );
  spyOn(walletKitClient, "selectedWalletId").mockImplementation(() => VARIAL_ID);
  silentAnswer = saved;
  lookups = mock(async () => silentAnswer);
  spyOn(walletKitClient, "silentWalletAddress").mockImplementation(
    lookups as unknown as typeof walletKitClient.silentWalletAddress
  );
}

function emitState(address: string | undefined): void {
  act(() => kit.stateListeners.forEach((listener) => listener({ payload: { address } })));
}

beforeEach(installKit);
afterEach(() => {
  mock.restore();
});

async function restored(options?: { recheckOnFocus?: boolean }) {
  const hook = renderHook(() => useWalletKitConnection("testnet", options));
  await waitFor(() => expect(hook.result.current.checking).toBe(false));
  await waitFor(() => expect(hook.result.current.status).not.toBe("checking"));
  return hook;
}

test("wallet connection › a restored session the wallet confirms is connected, on the page's network", async () => {
  const { result } = await restored();
  expect(result.current.status).toBe("connected");
  expect(result.current.network).toBe("yes");
  expect(result.current.verified).toBe(true);
  expect(lookups).toHaveBeenCalledTimes(1);
  // Never through the kit's own fetch or connect, which open prompts for most wallets.
  expect(kit.fetchAddress).not.toHaveBeenCalled();
  expect(kit.authModal).not.toHaveBeenCalled();
});

test("wallet connection › a wallet on another network blocks signing", async () => {
  kit.network = { networkPassphrase: Networks.PUBLIC };
  const { result } = await restored();
  expect(result.current.network).toBe("no");
  expect(result.current.verified).toBe(false);
  act(() => result.current.confirmNetwork(true));
  // A confirmation does nothing against a wallet that said it is elsewhere.
  expect(result.current.verified).toBe(false);
});

test.each([
  ["does not implement the network query", new Error("getNetwork is not a function")],
  ["answers with no network", { networkPassphrase: "" }],
])(
  "wallet connection › a wallet that %s is unknown and needs the user's confirmation",
  async (_, answer) => {
    kit.network = answer;
    const { result } = await restored();
    expect(result.current.network).toBe("unknown");
    expect(result.current.verified).toBe(false);
    act(() => result.current.confirmNetwork(true));
    expect(result.current.networkConfirmed).toBe(true);
    expect(result.current.verified).toBe(true);
  }
);

test("wallet connection › a confirmed network is cleared when the address changes, and asked again on coming back", async () => {
  kit.network = new Error("unsupported");
  const { result } = await restored();
  act(() => result.current.confirmNetwork(true));
  expect(result.current.verified).toBe(true);

  emitState(other);
  await waitFor(() => expect(result.current.address).toBe(other));
  expect(result.current.networkConfirmed).toBe(false);
  expect(result.current.verified).toBe(false);

  emitState(saved);
  await waitFor(() => expect(result.current.address).toBe(saved));
  expect(result.current.networkConfirmed).toBe(false);
});

test("wallet connection › a confirmed network is cleared when the wallet's network answer changes", async () => {
  kit.network = new Error("unsupported");
  const { result } = await restored({ recheckOnFocus: true });
  act(() => result.current.confirmNetwork(true));
  expect(result.current.verified).toBe(true);

  kit.network = { networkPassphrase: Networks.PUBLIC };
  const now = Date.now();
  spyOn(Date, "now").mockImplementation(() => now + RECHECK_INTERVAL_MS + 1);
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  await waitFor(() => expect(result.current.network).toBe("no"));
  expect(result.current.networkConfirmed).toBe(false);
  expect(result.current.verified).toBe(false);
});

test.each([
  ["answers another account", () => other],
  ["does not answer", () => null],
  ["cannot be asked without a prompt", () => "unsupported" as const],
])(
  "wallet connection › a restored session whose wallet %s is stale, never connected",
  async (_, answer) => {
    silentAnswer = answer();
    const { result } = await restored();
    expect(result.current.status).toBe("stale");
    expect(result.current.verified).toBe(false);
    expect(result.current.address).toBe(saved);
  }
);

test("wallet connection › a stale restored session shows Reconnect wallet, not Connected", async () => {
  silentAnswer = other;
  function Panel() {
    const connection = useWalletKitConnection("testnet");
    return <WalletConnectPanel connection={connection} signingNetwork="testnet" />;
  }
  render(<Panel />);
  expect(await screen.findByRole("button", { name: "Reconnect wallet" })).toBeDefined();
  expect(screen.queryByText(/Connected:/)?.textContent ?? null).toBeNull();
});

test("wallet connection › a state update with a new address replaces the session", async () => {
  const { result } = await restored();
  expect(result.current.verified).toBe(true);

  kit.network = new Error("unsupported");
  emitState(other);

  await waitFor(() => expect(result.current.address).toBe(other));
  expect(result.current.status).toBe("connected");
  // Readiness decided for the earlier address does not carry over.
  await waitFor(() => expect(result.current.network).toBe("unknown"));
  expect(result.current.verified).toBe(false);
});

test("wallet connection › the saved address the kit reports on subscribing is not taken as checked", async () => {
  silentAnswer = null;
  const { result } = await restored();
  expect(result.current.status).toBe("stale");
});

test("wallet connection › ten focus events in a second trigger one lookup", async () => {
  const { result } = await restored({ recheckOnFocus: true });
  expect(lookups).toHaveBeenCalledTimes(1);

  const start = Date.now() + RECHECK_INTERVAL_MS + 1;
  let now = start;
  spyOn(Date, "now").mockImplementation(() => now);
  // Each event lands after the one before it settled, so only the 5 s spacing can hold them back.
  for (let i = 0; i < 10; i++) {
    now = start + i * 100;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(result.current.checking).toBe(false));
  }
  expect(lookups).toHaveBeenCalledTimes(2);
  expect(kit.fetchAddress).not.toHaveBeenCalled();
  expect(kit.authModal).not.toHaveBeenCalled();
});

test("wallet connection › a focus re-check that finds another account makes the session stale", async () => {
  const { result } = await restored({ recheckOnFocus: true });
  silentAnswer = other;
  const now = Date.now();
  spyOn(Date, "now").mockImplementation(() => now + RECHECK_INTERVAL_MS + 1);
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await waitFor(() => expect(result.current.status).toBe("stale"));
  expect(result.current.verified).toBe(false);
});

test("wallet connection › a check still running holds the session as checking until it settles", async () => {
  let answer: (value: string) => void = () => {};
  lookups = mock(
    () =>
      new Promise<string>((resolve) => {
        answer = resolve;
      })
  );
  spyOn(walletKitClient, "silentWalletAddress").mockImplementation(
    lookups as unknown as typeof walletKitClient.silentWalletAddress
  );
  const { result } = renderHook(() => useWalletKitConnection("testnet"));
  await waitFor(() => expect(result.current.checking).toBe(true));
  expect(result.current.verified).toBe(false);
  await act(async () => answer(saved));
  await waitFor(() => expect(result.current.checking).toBe(false));
  expect(result.current.verified).toBe(true);
});

function unknownNetworkConnection(): WalletKitConnection {
  return {
    address: saved,
    status: "connected",
    checking: false,
    connecting: false,
    error: null,
    network: "unknown",
    networkConfirmed: false,
    confirmNetwork: () => {},
    verified: false,
    beforeSigning: () => async () => {},
    connect: async () => {},
    disconnect: async () => {},
  };
}

test.each([
  ["mainnet", "MAINNET"],
  ["testnet", "TESTNET"],
] as const)(
  "wallet connection › an unknown network on %s asks to confirm the wallet is on %s",
  (network, name) => {
    render(<WalletConnectPanel connection={unknownNetworkConnection()} signingNetwork={network} />);
    expect(
      screen.getByRole("checkbox", {
        name: `Your wallet does not report which network it is on. I checked that it is set to ${name}.`,
      })
    ).toBeDefined();
  }
);

test("wallet connection › a screen that does not sign never asks to confirm the network", () => {
  render(<WalletConnectPanel connection={unknownNetworkConnection()} />);
  expect(screen.queryByRole("checkbox")?.outerHTML ?? null).toBeNull();
});

test("wallet connection › ten focus events while a lookup is still running join it", async () => {
  const { result } = await restored({ recheckOnFocus: true });
  let answer: (value: string) => void = () => {};
  lookups.mockImplementation(
    () =>
      new Promise<string>((resolve) => {
        answer = resolve;
      })
  );
  const start = Date.now() + RECHECK_INTERVAL_MS + 1;
  let now = start;
  spyOn(Date, "now").mockImplementation(() => now);
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  // Later events, already past the spacing, while the first lookup has not answered.
  for (let i = 1; i < 10; i++) {
    now = start + RECHECK_INTERVAL_MS + i * 100;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
  }
  expect(lookups).toHaveBeenCalledTimes(2);
  await act(async () => answer(saved));
  await waitFor(() => expect(result.current.checking).toBe(false));
});

test("wallet connection › no render ever counts a confirmation for an address it was not given for", async () => {
  kit.network = new Error("unsupported");
  const renders: { address: string | null; verified: boolean }[] = [];
  const { result } = renderHook(() => {
    const connection = useWalletKitConnection("testnet");
    renders.push({ address: connection.address, verified: connection.verified });
    return connection;
  });
  await waitFor(() => expect(result.current.status).toBe("connected"));
  act(() => result.current.confirmNetwork(true));
  expect(result.current.verified).toBe(true);

  emitState(other);
  await waitFor(() => expect(result.current.address).toBe(other));
  expect(renders.filter((r) => r.address === other && r.verified)).toEqual([]);
});

test("wallet connection › reconnecting the same wallet and address asks for the network again", async () => {
  kit.network = new Error("unsupported");
  const { result } = await restored();
  act(() => result.current.confirmNetwork(true));
  expect(result.current.verified).toBe(true);

  await act(async () => {
    await result.current.connect();
  });
  expect(kit.authModal).toHaveBeenCalledTimes(1);
  expect(result.current.address).toBe(saved);
  expect(result.current.networkConfirmed).toBe(false);
  expect(result.current.verified).toBe(false);
});

// The check a run makes right before each signature reads the session as it is at that moment.
async function guardOutcome(guard: () => Promise<void>): Promise<string | null> {
  return guard().then(
    () => null,
    (err: unknown) => (err instanceof WalletNotUsableError ? err.reason : String(err))
  );
}

test("wallet connection › before signing, a usable session passes", async () => {
  const { result } = await restored();
  expect(await guardOutcome(result.current.beforeSigning(saved))).toBeNull();
});

test("wallet connection › before signing, a session for another address is refused", async () => {
  const { result } = await restored();
  expect(await guardOutcome(result.current.beforeSigning(other))).toBe("session");
});

test("wallet connection › a guard taken before a re-check finds the wallet on another network refuses", async () => {
  const { result } = await restored({ recheckOnFocus: true });
  // Taken at the start of a run, used later at the next signature.
  const guard = result.current.beforeSigning(saved);
  kit.network = { networkPassphrase: Networks.PUBLIC };
  const now = Date.now();
  spyOn(Date, "now").mockImplementation(() => now + RECHECK_INTERVAL_MS + 1);
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  // The re-check is still in flight: the guard waits for it instead of reading the old answer.
  expect(await guardOutcome(guard)).toBe("network");
});

test("wallet connection › a guard refuses a session that went stale after the run started", async () => {
  const { result } = await restored({ recheckOnFocus: true });
  const guard = result.current.beforeSigning(saved);
  silentAnswer = other;
  const now = Date.now();
  spyOn(Date, "now").mockImplementation(() => now + RECHECK_INTERVAL_MS + 1);
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  expect(await guardOutcome(guard)).toBe("session");
});

test("wallet connection › a guard refuses an unknown network whose confirmation was cleared", async () => {
  kit.network = new Error("unsupported");
  const { result } = await restored();
  act(() => result.current.confirmNetwork(true));
  const guard = result.current.beforeSigning(saved);
  expect(await guardOutcome(guard)).toBeNull();
  act(() => result.current.confirmNetwork(false));
  expect(await guardOutcome(guard)).toBe("network-unconfirmed");
});

function withProjectId(id: string | undefined, fn: () => void): void {
  const saved = process.env.NEXT_PUBLIC_STELLAR_WALLET_CONNECT_PROJECT_ID;
  if (id === undefined) delete process.env.NEXT_PUBLIC_STELLAR_WALLET_CONNECT_PROJECT_ID;
  else process.env.NEXT_PUBLIC_STELLAR_WALLET_CONNECT_PROJECT_ID = id;
  try {
    fn();
  } finally {
    if (saved === undefined) delete process.env.NEXT_PUBLIC_STELLAR_WALLET_CONNECT_PROJECT_ID;
    else process.env.NEXT_PUBLIC_STELLAR_WALLET_CONNECT_PROJECT_ID = saved;
  }
}

function disconnected(): WalletKitConnection {
  return { ...unknownNetworkConnection(), address: null, status: "disconnected" };
}

test("wallet connection › without a WalletConnect project id the picker says mobile wallets are unavailable", () => {
  withProjectId(undefined, () => {
    render(<WalletConnectPanel connection={disconnected()} />);
    expect(screen.getByText(NO_WALLET_CONNECT_NOTE)).toBeDefined();
  });
});

test("wallet connection › with a WalletConnect project id the picker has no such note", () => {
  withProjectId("0".repeat(32), () => {
    render(<WalletConnectPanel connection={disconnected()} />);
    expect(screen.queryByText(NO_WALLET_CONNECT_NOTE)?.textContent ?? null).toBeNull();
  });
});
