import { expect, test, type Page, type Route } from "@playwright/test";
import { Keypair } from "@stellar/stellar-sdk";
import { installWalletStub } from "../helpers/wallet-stub";
import { expectNoAxeViolations } from "./axe";
import { installApiFixtures, watchKit, watchPollar } from "./fixtures";

const CONTRACT = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
const NEW_KEY = "lw_test_placeholder_not_a_real_key";

function keyRecord(n: number, fields: Record<string, unknown> = {}) {
  return {
    id: String(n).repeat(64),
    createdAt: "2026-01-01T00:00:00.000Z",
    revokedAt: null,
    rotatedFrom: null,
    label: null,
    networks: null,
    lastUsedAt: null,
    usage: { today: 0, last30Days: 0, rateLimitedLast30Days: 0 },
    ...fields,
  };
}

let api: Awaited<ReturnType<typeof installApiFixtures>>;

test.beforeEach(async ({ page }) => {
  api = await installApiFixtures(page);
});

test.afterEach(() => api.expectAllAnswered());

function json(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "Cache-Control": "no-store" },
    body: JSON.stringify(body),
  });
}

/**
 * Answers the key page's own routes as the web proxy would: the session is a cookie the browser
 * never reads, so here it is a flag kept by the fixture across reloads, and every body carries
 * only the address and expiry.
 */
interface IntegratorOptions {
  /** The `keys` of `GET keys`; empty by default. */
  keys?: unknown[];
  /** The answer to `POST keys`; a created key by default. */
  create?: { status: number; body: unknown };
}

async function installIntegratorFixtures(
  page: Page,
  options: IntegratorOptions = {}
): Promise<{ signatures: string[]; created: unknown[] }> {
  let session: { address: string; expiresAt: string } | null = null;
  const signatures: string[] = [];
  const created: unknown[] = [];
  const challenge = (address: string) =>
    `LumenWipe API keys sign-in\nAddress: ${address}\nNonce: n`;

  await page.route("**/api/integrator/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/integrator/", "");
    const key = `${request.method()} ${path}`;
    if (key === "GET auth/session") {
      return session
        ? json(route, session)
        : json(route, { error: { code: "unauthorized", message: "Not signed in." } }, 401);
    }
    if (key === "POST auth/challenge") {
      const { address } = request.postDataJSON() as { address: string };
      return json(route, { message: challenge(address), expiresAt: new Date().toISOString() });
    }
    if (key === "POST auth/session") {
      const { address, message, signature } = request.postDataJSON() as Record<string, string>;
      const valid =
        message === challenge(address) &&
        Keypair.fromPublicKey(address).verifyMessage(message, Buffer.from(signature, "base64"));
      if (!valid) {
        return json(route, { error: { code: "invalid_challenge", message: "Invalid." } }, 401);
      }
      signatures.push(signature);
      session = { address, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() };
      return json(route, session);
    }
    if (key === "GET keys") {
      return json(route, { keys: options.keys ?? [], usage: { today: 0, last30Days: 0 } });
    }
    if (key === "POST keys") {
      created.push(request.postDataJSON());
      const reply = options.create ?? { status: 201, body: { key: NEW_KEY, record: keyRecord(9) } };
      return json(route, reply.body, reply.status);
    }
    if (key === "DELETE auth/session") {
      session = null;
      return route.fulfill({ status: 204 });
    }
    return json(route, { error: { code: "UNROUTED", message: key } }, 500);
  });
  return { signatures, created };
}

async function signInWithStubWallet(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Sign in with a Stellar wallet" }).click();
  await page.getByText("Varial", { exact: true }).click();
}

test("a plain wallet signs in, sees key management and the limits, and stays signed in on reload", async ({
  page,
}) => {
  const owner = Keypair.random();
  await installWalletStub(page, {
    address: owner.publicKey(),
    sign: { kind: "approve", keypair: owner },
  });
  const integrator = await installIntegratorFixtures(page);
  const seen = watchKit(page);
  const pollar = watchPollar(page);

  await page.goto("/api-keys");
  await expect(page).toHaveTitle(/API keys/);
  await expect(page.getByRole("heading", { name: "How keys work" })).toBeVisible();
  await expect(page.getByText(/up to 5 active keys/)).toBeVisible();
  await expect(page.getByText(/120 requests per 60 seconds/)).toBeVisible();
  await expectNoAxeViolations(page, "api keys, signed out");
  await page.waitForLoadState("networkidle");
  expect(seen.kitScripts).toEqual([]);
  expect(await pollar.scripts()).toEqual([]);

  await signInWithStubWallet(page);
  await expect(page.getByText(`Signed in as ${owner.publicKey()}`)).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole("button", { name: "Create key" })).toBeVisible();
  expect(integrator.signatures).toHaveLength(1);
  expect(seen.kitScripts.length).toBeGreaterThan(0);
  expect(await pollar.scripts()).toEqual([]);
  expect(pollar.requests).toEqual([]);
  await expectNoAxeViolations(page, "api keys, signed in");

  await page.reload();
  await expect(page.getByText(`Signed in as ${owner.publicKey()}`)).toBeVisible();
  await expect(page.getByRole("button", { name: "Create key" })).toBeVisible();
  expect(integrator.signatures).toHaveLength(1);
});

test("a contract account sees why it cannot sign in and what to do instead", async ({ page }) => {
  await installWalletStub(page, { address: CONTRACT });
  const integrator = await installIntegratorFixtures(page);

  await page.goto("/api-keys");
  await signInWithStubWallet(page);
  await expect(page.getByText("Contract accounts cannot own keys yet")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(/from Varial \(formerly Freighter\), xBull or Hana/)).toBeVisible();
  expect(integrator.signatures).toHaveLength(0);
  await expectNoAxeViolations(page, "api keys, contract account");
});

test("account sign-in loads only once it is chosen, and every Pollar call stays local", async ({
  page,
}) => {
  await installIntegratorFixtures(page);
  const pollar = watchPollar(page);
  await page.goto("/api-keys");
  const choice = page.getByRole("button", { name: "Continue with Google, GitHub or email" });
  await expect(choice).toBeEnabled();
  await page.waitForLoadState("networkidle");
  expect(await pollar.scripts()).toEqual([]);
  expect(pollar.requests).toEqual([]);

  const google = page.getByRole("button", { name: "Continue with Google", exact: true });
  const github = page.getByRole("button", { name: "Continue with GitHub", exact: true });
  await choice.hover();
  await choice.focus();
  await expect.poll(async () => (await pollar.scripts()).length).toBeGreaterThan(0);
  // No event marks the end of the prefetched module's evaluation, so it gets a settle window.
  await page.waitForTimeout(1_000);
  expect(pollar.requests).toEqual([]);
  await expect(google).toHaveCount(0);
  await expect(github).toHaveCount(0);

  await choice.click();
  await expect(google).toBeVisible();
  await expect(github).toBeVisible();
  await expect(page.getByRole("heading", { name: "Or continue with an account" })).toBeFocused();
  expect((await pollar.scripts()).length).toBeGreaterThan(0);
  await expect.poll(() => pollar.requests.length).toBeGreaterThan(0);
  await expectNoAxeViolations(page, "api keys, account sign-in loaded");
});

test("a session Pollar kept in this browser loads its sign-in with the page", async ({ page }) => {
  await installIntegratorFixtures(page);
  await page.addInitScript(() => localStorage.setItem("pollar:a11y:session", "{}"));
  const pollar = watchPollar(page);
  await page.goto("/api-keys");
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
  expect((await pollar.scripts()).length).toBeGreaterThan(0);
  await expect(
    page.getByRole("button", { name: "Continue with Google, GitHub or email" })
  ).toHaveCount(0);
});

const POLLAR_API = "https://sdk.api.pollar.xyz";
const EMAIL = "a11y-owner@example.test";

/** The only Pollar calls an email sign-in makes up to the code step, answered here. */
const POLLAR_REPLIES: Record<string, unknown> = {
  "GET /v3/applications/config": {
    code: "SDK_APPLICATION_CONFIG",
    success: true,
    content: {
      application: { name: "LumenWipe a11y", network: "testnet", chains: ["STELLAR"] },
      styles: { emailEnabled: true, providers: { google: true, github: true } },
    },
  },
  "POST /v3/auth/session": { success: true, content: { clientSessionId: "a11y-session" } },
  "POST /v3/auth/email": { code: "SDK_EMAIL_CODE_SENT", success: true, content: {} },
};

/** Answers Pollar's email calls locally and records any other call to its API, which a test fails
 *  on, so an SDK that starts calling something new shows up here. */
async function installPollarEmailStub(page: Page): Promise<{ unexpected: string[] }> {
  const unexpected: string[] = [];
  await page.route(`${POLLAR_API}/**`, (route) => {
    const request = route.request();
    const headers = request.headers();
    const cors = {
      "Access-Control-Allow-Origin": headers["origin"] ?? "*",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Headers": headers["access-control-request-headers"] ?? "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    };
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const key = `${request.method()} ${new URL(request.url()).pathname}`;
    if (!Object.hasOwn(POLLAR_REPLIES, key)) {
      unexpected.push(key);
      return route.abort();
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: cors,
      body: JSON.stringify(POLLAR_REPLIES[key]),
    });
  });
  return { unexpected };
}

test("email sign-in asks for the address, then the code, and the address stays with Pollar", async ({
  page,
}) => {
  await installIntegratorFixtures(page);
  const pollar = await installPollarEmailStub(page);
  const leaks: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin === POLLAR_API) return;
    if (`${request.url()}\n${request.postData() ?? ""}`.includes(EMAIL)) leaks.push(request.url());
  });

  await page.goto("/api-keys");
  await page.getByRole("button", { name: "Continue with Google, GitHub or email" }).click();
  const email = page.getByRole("textbox", { name: "Email" });
  await expect(email).toBeVisible();
  await expectNoAxeViolations(page, "api keys, email sign-in address");

  await email.fill(EMAIL);
  await page.getByRole("button", { name: "Continue with email" }).click();
  const code = page.getByRole("textbox", { name: "Code" });
  await expect(code).toBeVisible();
  await expect(
    page.getByText(`Enter the 6-digit code we sent to ${EMAIL}.`, { exact: false })
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Send a new code in \d+s/ })).toBeDisabled();
  await expectNoAxeViolations(page, "api keys, email sign-in code");

  expect(page.url()).not.toContain(EMAIL);
  expect(page.url()).not.toContain(encodeURIComponent(EMAIL));
  expect(leaks).toEqual([]);
  expect(pollar.unexpected).toEqual([]);
});

async function signInAs(page: Page, options: IntegratorOptions) {
  const owner = Keypair.random();
  await installWalletStub(page, {
    address: owner.publicKey(),
    sign: { kind: "approve", keypair: owner },
  });
  const integrator = await installIntegratorFixtures(page, options);
  await page.goto("/api-keys");
  await signInWithStubWallet(page);
  await expect(page.getByText(`Signed in as ${owner.publicKey()}`)).toBeVisible({
    timeout: 30_000,
  });
  return integrator;
}

test("keys show their label, scope, last use and counts, and a scoped key can be created", async ({
  page,
}) => {
  const integrator = await signInAs(page, {
    keys: [
      keyRecord(1, {
        label: "Production",
        networks: ["mainnet"],
        lastUsedAt: "2026-03-04T05:06:07.000Z",
        usage: { today: 3, last30Days: 40, rateLimitedLast30Days: 2 },
      }),
      keyRecord(2, { usage: null }),
    ],
  });
  // The scope names are also the create form's radio labels, so every check is made inside a row.
  const keyRows = page.getByRole("listitem").filter({ hasText: "Created" });
  await expect(keyRows).toHaveCount(2);
  const production = keyRows.filter({ hasText: "Production" });
  await expect(production.getByText("Mainnet only", { exact: true })).toBeVisible();
  await expect(production.getByText("3 today · 40 in 30 days · 2 rate-limited")).toBeVisible();
  const untitled = keyRows.filter({ hasText: "Untitled key" });
  await expect(untitled.getByText("All networks", { exact: true })).toBeVisible();
  await expect(untitled.getByText("Never used")).toBeVisible();
  await expect(untitled.getByText("Usage unavailable")).toBeVisible();
  await expectNoAxeViolations(page, "api keys, keys with label, scope and usage");

  await page.getByRole("textbox", { name: "Label (optional)" }).fill("staging");
  await page.getByRole("radio", { name: "Testnet only" }).check();
  await page.getByRole("button", { name: "Create key" }).click();
  await expect(page.getByRole("heading", { name: /Copy your key now/ })).toBeFocused();
  expect(integrator.created).toEqual([{ label: "staging", networks: ["testnet"] }]);
});

test("at the active-key limit create is disabled and the next step is named", async ({ page }) => {
  await signInAs(page, { keys: [1, 2, 3, 4, 5].map((n) => keyRecord(n)) });
  await expect(page.getByRole("button", { name: "Create key" })).toBeDisabled();
  await expect(page.getByText(/Revoke or rotate one under Manage/)).toBeVisible();
  await expectNoAxeViolations(page, "api keys, at the key limit");
});

test("a label the API refuses is shown on the label field", async ({ page }) => {
  await signInAs(page, {
    create: { status: 400, body: { error: { code: "invalid_label", message: "Bad label." } } },
  });
  const label = page.getByRole("textbox", { name: "Label (optional)" });
  await label.fill("ops");
  await page.getByRole("button", { name: "Create key" }).click();
  await expect(page.getByText("Use up to 64 printable characters.")).toBeVisible();
  await expect(label).toBeFocused();
  await expect(label).toHaveAttribute("aria-invalid", "true");
  await expectNoAxeViolations(page, "api keys, refused label");
});
