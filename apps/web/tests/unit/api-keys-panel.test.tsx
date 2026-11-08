import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";
import { ALBEDO_ID } from "@creit-tech/stellar-wallets-kit/modules/albedo";
import { VARIAL_ID } from "@creit-tech/stellar-wallets-kit/modules/varial";
import * as walletKitClient from "@/lib/wallet-kit/client";
import ApiKeysPanel, { SESSION_ENDED, SIGNED_OUT } from "@/components/api-keys/ApiKeysPanel";
import { expectFocused } from "./fixtures/focus";

const owner = Keypair.random();
const CONTRACT = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
const NEW_KEY = "lw_test_placeholder_not_a_real_key";
const RECORD = {
  id: "a".repeat(64),
  createdAt: "2026-01-01T00:00:00.000Z",
  revokedAt: null,
  rotatedFrom: null,
};

type Reply = { status: number; body?: unknown };
let routes: Record<string, Reply | (() => Reply)>;
let requests: string[];

const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

function signedIn(expiresAt = inMinutes(30)): Record<string, Reply> {
  return {
    "GET auth/session": { status: 200, body: { address: owner.publicKey(), expiresAt } },
    "GET keys": { status: 200, body: { keys: [RECORD], usage: { today: 1, last30Days: 2 } } },
    "POST keys": { status: 200, body: { key: NEW_KEY, record: RECORD } },
    "DELETE auth/session": { status: 204 },
  };
}

const unauthorized: Reply = {
  status: 401,
  body: { error: { code: "unauthorized", message: "You are not signed in." } },
};

const realFetch = globalThis.fetch;

let kit: {
  address: string;
  walletId: string;
  signMessage: ReturnType<typeof mock>;
  disconnect: ReturnType<typeof mock>;
};

beforeEach(() => {
  requests = [];
  routes = {};
  globalThis.fetch = mock(async (url: string, init: RequestInit) => {
    const key = `${init.method ?? "GET"} ${url.replace("/api/integrator/", "")}`;
    requests.push(key);
    const route = routes[key];
    const reply = typeof route === "function" ? route() : (route ?? { status: 500 });
    if (reply.status === 204) return new Response(null, { status: 204 });
    return Response.json(reply.body ?? {}, { status: reply.status });
  }) as unknown as typeof fetch;

  kit = {
    address: owner.publicKey(),
    walletId: VARIAL_ID,
    signMessage: mock(async (message: string) => ({
      signedMessage: Buffer.from(owner.signMessage(message)).toString("base64"),
      signerAddress: owner.publicKey(),
    })),
    disconnect: mock(async () => {}),
  };
  const fake = {
    authModal: async () => ({ address: kit.address }),
    getNetwork: async () => ({ networkPassphrase: "Test SDF Network ; September 2015" }),
    signMessage: (...args: unknown[]) => kit.signMessage(...args),
    disconnect: () => kit.disconnect(),
  };
  spyOn(walletKitClient, "ensureWalletKitInitialized").mockImplementation(
    () => fake as unknown as ReturnType<typeof walletKitClient.ensureWalletKitInitialized>
  );
  spyOn(walletKitClient, "selectedWalletId").mockImplementation(() => kit.walletId);
});

afterEach(() => {
  globalThis.fetch = realFetch;
  mock.restore();
});

const signInButton = () => screen.findByRole("button", { name: "Sign in with a Stellar wallet" });
const status = () => screen.getAllByRole("status").find((n) => n.tagName === "P")!;

describe("the API keys panel", () => {
  test("restores a session from the cookie and focuses a revealed key", async () => {
    routes = signedIn();
    render(<ApiKeysPanel />);
    expect(await screen.findByText(`Signed in as ${owner.publicKey()}`)).toBeTruthy();
    expect(await screen.findByText("Key aaaaaaaa")).toBeTruthy();
    expect(screen.getByText(/Session ends at/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Create key" }));
    const heading = await screen.findByRole("heading", { name: /Copy your key now/ });
    await expectFocused(heading, "revealed key");
    expect(screen.getByText(NEW_KEY)).toBeTruthy();
  });

  test("signing out ends the session, keeps a revealed key and returns focus to sign-in", async () => {
    routes = signedIn();
    render(<ApiKeysPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Create key" }));
    await screen.findByText(NEW_KEY);

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await expectFocused(await signInButton(), "sign in after sign out");
    expect(requests).toContain("DELETE auth/session");
    expect(status().textContent).toBe(SIGNED_OUT);
    expect(screen.getByText(NEW_KEY)).toBeTruthy();
  });

  test("signing out after a wallet sign-in keeps the wallet connected", async () => {
    const session = signedIn();
    routes = {
      "GET auth/session": unauthorized,
      "POST auth/challenge": { status: 200, body: { message: "challenge text" } },
      "POST auth/session": session["GET auth/session"],
      "GET keys": session["GET keys"],
      "DELETE auth/session": { status: 204 },
    };
    render(<ApiKeysPanel />);
    fireEvent.click(await signInButton());
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    await expectFocused(await signInButton(), "sign in after sign out");
    expect(requests).toContain("DELETE auth/session");
    expect(kit.disconnect).not.toHaveBeenCalled();
  });

  test("signing out of a restored session keeps the wallet connected", async () => {
    routes = signedIn();
    render(<ApiKeysPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    await expectFocused(await signInButton(), "sign in after sign out");
    expect(kit.disconnect).not.toHaveBeenCalled();
  });

  test("a 401 from the API returns to signed-out and says why", async () => {
    routes = { ...signedIn(), "POST keys": unauthorized };
    render(<ApiKeysPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Create key" }));
    await expectFocused(await signInButton(), "sign in after 401");
    expect(status().textContent).toBe(SESSION_ENDED);
  });

  test("the session's end returns to signed-out", async () => {
    routes = signedIn(new Date(Date.now() + 150).toISOString());
    render(<ApiKeysPanel />);
    await screen.findByText(`Signed in as ${owner.publicKey()}`);
    await expectFocused(await signInButton(), "sign in after expiry", 2_000);
    expect(status().textContent).toBe(SESSION_ENDED);
  });

  test("names the wallet as the next step when Google and GitHub are not set up", async () => {
    routes = { "GET auth/session": unauthorized };
    render(<ApiKeysPanel />);
    await signInButton();
    expect(screen.getByText(/Google and GitHub sign-in are not set up here/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "SDK quickstart" })).toBeTruthy();
  });

  test("explains a server without key management, with links", async () => {
    routes = {
      "GET auth/session": {
        status: 503,
        body: { error: { code: "integrator_api_not_configured", message: "Off." } },
      },
    };
    render(<ApiKeysPanel />);
    const callout = await screen.findByRole("alert");
    expect(callout.textContent).toContain("Key management is not available right now");
    expect(callout.querySelector('a[href*="api-reference/introduction"]')).toBeTruthy();
    expect(callout.querySelector('a[href*="sdk/overview"]')).toBeTruthy();
  });

  test("signs in with a wallet, never handling a token", async () => {
    const session = signedIn();
    routes = {
      "GET auth/session": unauthorized,
      "POST auth/challenge": { status: 200, body: { message: "challenge text" } },
      "POST auth/session": session["GET auth/session"],
      "GET keys": session["GET keys"],
    };
    render(<ApiKeysPanel />);
    fireEvent.click(await signInButton());
    expect(await screen.findByText(`Signed in as ${owner.publicKey()}`)).toBeTruthy();
    expect(kit.signMessage).toHaveBeenCalledTimes(1);
    expect(status().textContent).toBe("Signed in.");
  });

  test("explains a contract account in plain language", async () => {
    routes = { "GET auth/session": unauthorized };
    kit.address = CONTRACT;
    render(<ApiKeysPanel />);
    fireEvent.click(await signInButton());
    const callout = await screen.findByRole("alert");
    expect(callout.textContent).toContain("Contract accounts cannot own keys yet");
    expect(requests).not.toContain("POST auth/challenge");
  });

  test("explains a wallet that cannot sign a message, after it is picked", async () => {
    routes = { "GET auth/session": unauthorized };
    kit.walletId = ALBEDO_ID;
    render(<ApiKeysPanel />);
    fireEvent.click(await signInButton());
    const callout = await screen.findByRole("alert");
    expect(callout.textContent).toContain("Albedo cannot sign in here");
    expect(kit.signMessage).not.toHaveBeenCalled();
  });

  test("refuses a signature from another account before any session is asked for", async () => {
    routes = {
      "GET auth/session": unauthorized,
      "POST auth/challenge": { status: 200, body: { message: "challenge text" } },
    };
    const other = Keypair.random();
    kit.signMessage = mock(async (message: string) => ({
      signedMessage: Buffer.from(other.signMessage(message)).toString("base64"),
      signerAddress: other.publicKey(),
    }));
    render(<ApiKeysPanel />);
    const button = await signInButton();
    fireEvent.click(button);
    const error = await screen.findByText(/signed with a different account/);
    expect(requests).not.toContain("POST auth/session");
    await waitFor(() => expect(button.getAttribute("aria-describedby")).toBe("api-keys-error"));
    expect(error.closest("#api-keys-error")).toBeTruthy();
  });
});
