import { expect, test, type Page } from "@playwright/test";
import { Keypair } from "@stellar/stellar-sdk";
import { LocalStorageKeys } from "@creit-tech/stellar-wallets-kit/types";
import { openTestnetHome } from "../helpers/flow";
import { connectStubWallet, installWalletStub } from "../helpers/wallet-stub";
import { installApiFixtures, WALLET_CONNECT_HOSTS } from "./fixtures";

// A message only the kit's own code carries, so a script holding it is the kit's chunk.
const KIT_MARKER = "Please set the wallet first";

/** Records every script the page loads that holds the wallet kit, and every WalletConnect call. */
function watchKit(page: Page): { kitScripts: string[]; walletConnect: string[] } {
  const seen = { kitScripts: [] as string[], walletConnect: [] as string[] };
  page.on("request", (request) => {
    if (WALLET_CONNECT_HOSTS.test(request.url())) seen.walletConnect.push(request.url());
  });
  page.on("response", async (response) => {
    if (response.request().resourceType() !== "script") return;
    const body = await response.text().catch(() => "");
    if (body.includes(KIT_MARKER)) seen.kitScripts.push(response.url());
  });
  return seen;
}

function savedAddress(page: Page): Promise<string | null> {
  return page.evaluate((key) => localStorage.getItem(key), LocalStorageKeys.activeAddress);
}

test("a visitor with no saved wallet loads no wallet kit until choosing to connect", async ({
  page,
}) => {
  const api = await installApiFixtures(page);
  const seen = watchKit(page);
  await openTestnetHome(page);
  await expect(page.getByRole("tab", { name: "Connect wallet" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(seen.kitScripts).toEqual([]);
  expect(seen.walletConnect).toEqual([]);

  await page
    .getByRole("button", { name: /Connect wallet/i })
    .last()
    .click();
  await expect(page.getByText("Varial", { exact: true })).toBeVisible();
  expect(seen.kitScripts.length).toBeGreaterThan(0);
  api.expectAllAnswered();
});

test("a saved wallet session is restored on reload, and forgetting it loads no kit", async ({
  page,
}) => {
  const account = Keypair.random();
  await installWalletStub(page, { address: account.publicKey() });
  const api = await installApiFixtures(page);
  await openTestnetHome(page);
  await connectStubWallet(page);
  expect(await savedAddress(page)).toBe(account.publicKey());

  await page.reload();
  await expect(page.getByText(/Connected:/)).toBeVisible({ timeout: 30_000 });

  await page.evaluate((key) => localStorage.removeItem(key), LocalStorageKeys.activeAddress);
  const seen = watchKit(page);
  await page.reload();
  await expect(page.getByRole("tab", { name: "Connect wallet" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("button", { name: /Connect wallet/i }).last()).toBeVisible();
  await expect(page.getByText(/Connected:/)).toHaveCount(0);
  expect(seen.kitScripts).toEqual([]);
  expect(seen.walletConnect).toEqual([]);
  api.expectAllAnswered();
});
