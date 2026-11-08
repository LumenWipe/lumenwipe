import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Keypair } from "@stellar/stellar-sdk";
import { ALBEDO_ID } from "@creit-tech/stellar-wallets-kit/modules/albedo";
import { VARIAL_ID } from "@creit-tech/stellar-wallets-kit/modules/varial";
import * as walletKitClient from "@/lib/wallet-kit/client";
import ApiKeysPanel, {
  MAX_ACTIVE_KEYS,
  SESSION_ENDED,
  SIGNED_OUT,
} from "@/components/api-keys/ApiKeysPanel";
import { expectFocused } from "./fixtures/focus";

const owner = Keypair.random();
const CONTRACT = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
const NEW_KEY = "lw_test_placeholder_not_a_real_key";
const RECORD = {
  id: "a".repeat(64),
  createdAt: "2026-01-01T00:00:00.000Z",
  revokedAt: null,
  rotatedFrom: null,
  label: null,
  networks: null,
  lastUsedAt: null,
  usage: { today: 3, last30Days: 40, rateLimitedLast30Days: 2 },
};

function entry(n: number, fields: Record<string, unknown> = {}) {
  return { ...RECORD, id: String(n).repeat(64), ...fields };
}

type Reply = { status: number; body?: unknown };
let routes: Record<string, Reply | (() => Reply)>;
let requests: string[];
let bodies: Record<string, unknown[]>;

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
  bodies = {};
  routes = {};
  globalThis.fetch = mock(async (url: string, init: RequestInit) => {
    const key = `${init.method ?? "GET"} ${url.replace("/api/integrator/", "")}`;
    requests.push(key);
    if (typeof init.body === "string") (bodies[key] ??= []).push(JSON.parse(init.body));
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
    expect(await screen.findByText("Untitled key")).toBeTruthy();
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

  describe("creating a key with a label and a scope", () => {
    const createButton = () => screen.findByRole("button", { name: "Create key" });
    const labelInput = () => screen.findByRole("textbox", { name: "Label (optional)" });
    const posted = () => bodies["POST keys"] ?? [];
    const apiError = (status: number, code: string): Reply => ({
      status,
      body: { error: { code, message: `API says ${code}.` } },
    });

    test("sends an empty body for no label and every network", async () => {
      routes = signedIn();
      render(<ApiKeysPanel />);
      fireEvent.click(await createButton());
      await screen.findByText(NEW_KEY);
      expect(posted()).toEqual([{}]);
    });

    test("sends the trimmed label and the chosen network, then resets the form", async () => {
      routes = signedIn();
      render(<ApiKeysPanel />);
      const input = (await labelInput()) as HTMLInputElement;
      fireEvent.change(input, { target: { value: "  ops server  " } });
      fireEvent.click(screen.getByRole("radio", { name: "Mainnet only" }));
      fireEvent.click(await createButton());
      await screen.findByText(NEW_KEY);
      expect(posted()).toEqual([{ label: "ops server", networks: ["mainnet"] }]);
      expect(input.value).toBe("");
      expect(
        (screen.getByRole("radio", { name: "All networks" }) as HTMLInputElement).checked
      ).toBe(true);
    });

    test("leaves out a blank label and sends testnet only", async () => {
      routes = signedIn();
      render(<ApiKeysPanel />);
      fireEvent.change(await labelInput(), { target: { value: "   " } });
      fireEvent.click(screen.getByRole("radio", { name: "Testnet only" }));
      fireEvent.click(await createButton());
      await screen.findByText(NEW_KEY);
      expect(posted()).toEqual([{ networks: ["testnet"] }]);
    });

    test("groups the scope in a fieldset with a hint that it is fixed and kept on rotation", async () => {
      routes = signedIn();
      render(<ApiKeysPanel />);
      const group = await screen.findByRole("group", { name: "Networks" });
      expect(group.tagName).toBe("FIELDSET");
      const radios = screen.getAllByRole("radio") as HTMLInputElement[];
      expect(radios.map((r) => r.labels?.[0]?.textContent)).toEqual([
        "All networks",
        "Mainnet only",
        "Testnet only",
      ]);
      expect(new Set(radios.map((r) => r.name)).size).toBe(1);
      expect(radios[0].checked).toBe(true);
      const hint = document.getElementById(group.getAttribute("aria-describedby")!)!;
      expect(hint.textContent).toContain("Scope is fixed when the key is created");
      expect(hint.textContent).toContain("rotating the key keeps it");
      expect(hint.textContent).toContain("refused on routes that take no network");
    });

    test("counts the label in characters and announces the limit", async () => {
      routes = signedIn();
      render(<ApiKeysPanel />);
      const input = await labelInput();
      expect(screen.getByText("0/64")).toBeTruthy();
      fireEvent.change(input, { target: { value: "🔑".repeat(64) } });
      expect(screen.getByText("64/64")).toBeTruthy();
      expect(screen.getByText("The label is at the 64-character limit.")).toBeTruthy();

      fireEvent.click(await createButton());
      await screen.findByText(NEW_KEY);
      expect(posted()).toEqual([{ label: "🔑".repeat(64) }]);
    });

    test("refuses a label over 64 characters before sending, on the field", async () => {
      routes = signedIn();
      render(<ApiKeysPanel />);
      const input = await labelInput();
      fireEvent.change(input, { target: { value: "a".repeat(65) } });
      fireEvent.click(await createButton());
      const error = await screen.findByText("Use up to 64 printable characters.");
      await expectFocused(input, "label after a long label");
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(input.getAttribute("aria-describedby")).toContain(error.closest("p")!.id);
      expect(posted()).toEqual([]);
    });

    test("refuses a label with a control or format character before sending", async () => {
      routes = signedIn();
      render(<ApiKeysPanel />);
      const input = await labelInput();
      fireEvent.change(input, { target: { value: "ops​server" } });
      fireEvent.click(await createButton());
      await screen.findByText("Use up to 64 printable characters.");
      expect(posted()).toEqual([]);
    });

    test("shows the API's invalid_label on the label field and focuses it", async () => {
      routes = { ...signedIn(), "POST keys": apiError(400, "invalid_label") };
      render(<ApiKeysPanel />);
      const input = await labelInput();
      fireEvent.change(input, { target: { value: "ops" } });
      fireEvent.click(await createButton());
      await screen.findByText("Use up to 64 printable characters.");
      await expectFocused(input, "label after invalid_label");
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(document.getElementById("api-keys-error")).toBeNull();
    });

    test("shows the API's invalid_networks on the scope group and focuses its first choice", async () => {
      routes = { ...signedIn(), "POST keys": apiError(400, "invalid_networks") };
      render(<ApiKeysPanel />);
      fireEvent.click(await createButton());
      const error = await screen.findByText("Choose all networks, mainnet only or testnet only.");
      const group = screen.getByRole("group", { name: "Networks" });
      expect(group.getAttribute("aria-describedby")!.split(" ")).toContain(error.id);
      await expectFocused(screen.getByRole("radio", { name: "All networks" }), "first scope");
      expect(document.getElementById("api-keys-error")).toBeNull();
    });

    test("explains key_limit_reached on the form and reloads the list", async () => {
      routes = { ...signedIn(), "POST keys": apiError(409, "key_limit_reached") };
      render(<ApiKeysPanel />);
      fireEvent.click(await createButton());
      const message = await screen.findByText(
        `You already have ${MAX_ACTIVE_KEYS} active keys. Revoke one to create another.`
      );
      await waitFor(() => expect(requests.filter((r) => r === "GET keys")).toHaveLength(2));
      const button = await createButton();
      expect(button.getAttribute("aria-describedby")).toContain(message.closest("[id]")!.id);
      expect(document.getElementById("api-keys-error")).toBeNull();
    });

    test("leaves any other create error to the panel", async () => {
      routes = { ...signedIn(), "POST keys": apiError(400, "invalid_body") };
      render(<ApiKeysPanel />);
      fireEvent.click(await createButton());
      const error = await screen.findByText("API says invalid_body.");
      expect(error.closest("#api-keys-error")).toBeTruthy();
    });
  });

  describe("the key list", () => {
    const listed = (keys: unknown[]): Record<string, Reply> => ({
      ...signedIn(),
      "GET keys": { status: 200, body: { keys, usage: { today: 1, last30Days: 2 } } },
    });

    test("shows each key's label, scope, last use and counts", async () => {
      const used = "2026-03-04T05:06:07.000Z";
      routes = listed([
        entry(1, { label: "Production", networks: ["mainnet"], lastUsedAt: used }),
        entry(2, { networks: ["testnet"], usage: null }),
        entry(3, { networks: ["mainnet", "testnet"] }),
      ]);
      render(<ApiKeysPanel />);
      await screen.findByText("Production");
      const rows = screen
        .getAllByRole("listitem")
        .filter((li) => li.textContent?.includes("Created"));
      expect(rows).toHaveLength(3);
      const [production, untitled, both] = rows;

      expect(production.textContent).toContain("Production");
      expect(production.textContent).toContain("Mainnet only");
      expect(production.textContent).toContain("Last used");
      expect(production.querySelector("time")?.getAttribute("datetime")).toBe(used);
      expect(production.textContent).toContain("3 today · 40 in 30 days · 2 rate-limited");

      expect(untitled.textContent).toContain("Untitled key");
      expect(untitled.textContent).toContain("Testnet only");
      expect(untitled.textContent).toContain("Never used");
      expect(untitled.textContent).toContain("Usage unavailable");
      expect(untitled.textContent).not.toContain("today");

      expect(both.textContent).toContain("All networks");
      expect(screen.getByText("Last used is updated within a minute of a request.")).toBeTruthy();
    });

    test("names each Manage button uniquely, even for keys without a label", async () => {
      routes = listed([entry(1), entry(2)]);
      render(<ApiKeysPanel />);
      const buttons = await screen.findAllByRole("button", { name: /^Manage Untitled key/ });
      const names = buttons.map((b) => b.getAttribute("aria-label"));
      expect(names).toHaveLength(2);
      expect(new Set(names).size).toBe(2);
    });

    test("disables create at the active-key limit and names the next step", async () => {
      const keys = [1, 2, 3, 4, 5].map((n) => entry(n));
      routes = listed([...keys, entry(6, { revokedAt: "2026-02-01T00:00:00.000Z" })]);
      render(<ApiKeysPanel />);
      await screen.findByText("1 revoked or rotated");
      const button = screen.getByRole("button", { name: "Create key" }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      const next = document.getElementById(button.getAttribute("aria-describedby")!)!;
      expect(next.textContent).toContain(`You have ${MAX_ACTIVE_KEYS} active keys`);
      expect(next.textContent).toContain("Revoke or rotate one under Manage");
      fireEvent.submit(button.closest("form")!);
      expect(requests).not.toContain("POST keys");
    });

    test("keeps create available below the limit", async () => {
      routes = listed([1, 2, 3, 4].map((n) => entry(n)));
      render(<ApiKeysPanel />);
      await screen.findAllByRole("button", { name: /^Manage/ });
      const button = screen.getByRole("button", { name: "Create key" }) as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      expect(screen.queryByText(/the most a wallet can hold/)).toBeNull();
    });
  });
});
