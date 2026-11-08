import { expect, test, type Page, type Route } from "@playwright/test";
import { Keypair } from "@stellar/stellar-sdk";
import { installWalletStub } from "../helpers/wallet-stub";
import { expectNoAxeViolations } from "./axe";
import { installApiFixtures } from "./fixtures";

const CONTRACT = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";

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
async function installIntegratorFixtures(page: Page): Promise<{ signatures: string[] }> {
  let session: { address: string; expiresAt: string } | null = null;
  const signatures: string[] = [];
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
      return json(route, { keys: [], usage: { today: 0, last30Days: 0 } });
    }
    if (key === "DELETE auth/session") {
      session = null;
      return route.fulfill({ status: 204 });
    }
    return json(route, { error: { code: "UNROUTED", message: key } }, 500);
  });
  return { signatures };
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

  await page.goto("/api-keys");
  await expect(page).toHaveTitle(/API keys/);
  await expect(page.getByRole("heading", { name: "How keys work" })).toBeVisible();
  await expect(page.getByText(/up to 5 active keys/)).toBeVisible();
  await expect(page.getByText(/120 requests per 60 seconds/)).toBeVisible();
  await expectNoAxeViolations(page, "api keys, signed out");

  await signInWithStubWallet(page);
  await expect(page.getByText(`Signed in as ${owner.publicKey()}`)).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole("button", { name: "Create key" })).toBeVisible();
  expect(integrator.signatures).toHaveLength(1);
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

test("without Google and GitHub sign-in the page names the wallet as the next step", async ({
  page,
}) => {
  await installIntegratorFixtures(page);
  await page.goto("/api-keys");
  await expect(page.getByText(/Google and GitHub sign-in are not set up here/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in with a Stellar wallet" })).toBeEnabled();
  await expect(page.getByRole("link", { name: "SDK quickstart" }).first()).toBeVisible();
  await expectNoAxeViolations(page, "api keys, no account sign-in");
});
