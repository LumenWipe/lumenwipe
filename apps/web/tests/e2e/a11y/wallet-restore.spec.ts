import { expect, test, type Page } from "@playwright/test";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import { LocalStorageKeys } from "@creit-tech/stellar-wallets-kit/types";
import { confirmDestinationControl } from "../helpers/destination";
import { enterSourceAndAnalyze, expectSigningPanel, openTestnetHome } from "../helpers/flow";
import { connectStubWallet, installWalletStub } from "../helpers/wallet-stub";
import { installApiFixtures, watchKit } from "./fixtures";

function savedAddress(page: Page): Promise<string | null> {
  return page.evaluate((key) => localStorage.getItem(key), LocalStorageKeys.activeAddress);
}

const NO_KIT = { kitScripts: [], walletConnect: [] };

/** Selects `other`, then "Connect wallet" again. Only a hydrated form switches tabs, and React runs
 *  its pending mount effects, the saved-session check among them, before it handles a click. */
async function switchSignerTabsAndBack(page: Page, other: string): Promise<void> {
  for (const name of [other, "Connect wallet"]) {
    const tab = page.getByRole("tab", { name });
    await expect(async () => {
      await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true", { timeout: 1_000 });
    }).toPass();
  }
}

test("a visitor with no saved wallet loads no wallet kit until choosing to connect", async ({
  page,
}) => {
  const api = await installApiFixtures(page);
  const seen = watchKit(page);
  await openTestnetHome(page);
  await switchSignerTabsAndBack(page, "Paste address");
  seen.mark();
  expect(await seen.beforeMark()).toEqual(NO_KIT);

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
  // The restored page's kit keeps working after the assertion above, and WalletConnect calls it
  // makes late would land in a watch started on it. Once about:blank has loaded, it is gone.
  await page.goto("about:blank");
  const seen = watchKit(page);
  await page.goto("/testnet");
  await switchSignerTabsAndBack(page, "Paste address");
  seen.mark();
  expect(await seen.beforeMark()).toEqual(NO_KIT);
  await expect(page.getByText(/Connected:/)).toHaveCount(0);

  await page
    .getByRole("button", { name: /Connect wallet/i })
    .last()
    .click();
  await expect(page.getByText("Varial", { exact: true })).toBeVisible();
  expect(seen.kitScripts.length).toBeGreaterThan(0);
  api.expectAllAnswered();
});

test("the signing page loads no wallet kit until a wallet connects, then signs with it", async ({
  page,
}) => {
  const source = Keypair.random();
  const wallet = await installWalletStub(page, {
    address: source.publicKey(),
    sign: { kind: "approve", keypair: source },
  });
  const api = await installApiFixtures(page);
  const seen = watchKit(page);

  await enterSourceAndAnalyze(page, source.publicKey());
  await page
    .getByPlaceholder(/G\.\.\. \(where to send your XLM\)/)
    .fill(Keypair.random().publicKey());
  await confirmDestinationControl(page);
  await page.getByRole("button", { name: /Review the full plan/i }).click();
  await expect(page).toHaveURL(/\/testnet\/review/);
  await expect(page.getByRole("heading", { level: 1, name: "Review the full plan" })).toBeVisible();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: /Continue to signing/i }).click();
  await expect(page).toHaveURL(/\/testnet\/execute/);
  await expectSigningPanel(page);
  await switchSignerTabsAndBack(page, "Use secret key (advanced)");
  seen.mark();
  expect(await seen.beforeMark()).toEqual(NO_KIT);

  await connectStubWallet(page);
  expect(seen.kitScripts.length).toBeGreaterThan(0);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: /Sign & execute close/i }).click();
  await expect(page).toHaveURL(/\/testnet\/receipt\/[^/?#]+$/);
  expect(wallet.signRequests.map((r) => r.networkPassphrase)).toEqual([Networks.TESTNET]);
  api.expectAllAnswered();
});
