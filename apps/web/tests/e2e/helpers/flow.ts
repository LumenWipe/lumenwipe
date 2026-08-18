import { expect, type Page } from "@playwright/test";

/**
 * Steps every spec needs to reach the analyze flow, in one place.
 *
 * They used to be copied into each spec. When #95 moved the source-address field behind a
 * "Paste address" button, five copies went stale at once and stayed broken for days - the
 * suite does not run in CI, so nothing said so. Shared here so the next UI change is one edit
 * rather than six, and so a change that breaks entry fails loudly instead of timing out on a
 * locator that no longer resolves.
 */

/**
 * Dismisses the beta-risk notice.
 *
 * Waits rather than probing. A bare `isVisible()` does not auto-wait, so it can run before the
 * notice hydrates and return false - leaving the overlay up, silently intercepting clicks on
 * the form beneath it, and failing somewhere unrelated. Waiting for it to detach afterwards
 * closes the same race on the way out.
 */
export async function dismissRiskModal(page: Page): Promise<void> {
  const acceptRisk = page.getByRole("button", { name: /I understand, continue/i });
  await acceptRisk.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  if (await acceptRisk.isVisible().catch(() => false)) {
    await acceptRisk.click();
    await acceptRisk.waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
  }
}

/**
 * Reveals the raw address field and fills it.
 *
 * Connecting a wallet is the primary path since #95, so the field sits behind "Paste address".
 * These specs drive an address only - they never connect a wallet.
 */
export async function enterSourceAddress(page: Page, address: string): Promise<void> {
  const pasteAddress = page.getByRole("button", { name: /Paste address/i });
  await expect(pasteAddress).toBeVisible({ timeout: 15_000 });
  await pasteAddress.click();
  await page.getByPlaceholder(/G\.\.\. \(the account to merge\)/).fill(address);
}

/** Opens the testnet home page and clears the risk notice. */
export async function openTestnetHome(page: Page): Promise<void> {
  await page.goto("/testnet");
  await dismissRiskModal(page);
}

/**
 * Budget for a step that waits on live testnet, not on local rendering.
 *
 * Playwright's 5s default is right for asserting on DOM that is already there. It is arbitrary
 * for analyze -> review, which builds the whole close plan behind a Horizon read and a path
 * lookup, and for review -> execute. Those were left on the default and failed as "the button
 * did nothing" while the page still read "Preparing transaction..." - the work was in flight,
 * not broken. Assertions on already-rendered DOM keep the short default on purpose, so a
 * genuine hang still fails fast rather than hiding behind a blanket timeout.
 */
export const TESTNET_STEP_TIMEOUT = 30_000;

/**
 * Reveals the secret-key field and fills it.
 *
 * Same wallet-first redesign as the source address: signing defaults to a connected wallet and
 * the key field sits behind "Use secret key (advanced)". Specs that drove the placeholder
 * directly stopped finding it. These specs sign with a throwaway testnet key, never a wallet.
 */
export async function enterSecretKey(page: Page, secret: string): Promise<void> {
  const useSecretKey = page.getByRole("button", { name: /Use secret key \(advanced\)/i });
  await expect(useSecretKey).toBeVisible({ timeout: TESTNET_STEP_TIMEOUT });
  await useSecretKey.click();
  await page.getByPlaceholder("S...").fill(secret);
}

/** Waits for the execute page's signing panel to be ready. */
export async function expectSigningPanel(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: /Sign & execute the close/i })).toBeVisible({
    timeout: TESTNET_STEP_TIMEOUT,
  });
}
