import { expect, type Page } from "@playwright/test";
import { confirmDestinationControl } from "./destination";

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
  const notice = page.getByRole("heading", { name: /Beta Software/i });

  // Absence is legitimate: the notice mounts from an effect keyed on sessionStorage, so a
  // second navigation inside the same test never shows it. Only this wait is allowed to fail
  // quietly.
  await notice.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  if (!(await notice.isVisible().catch(() => false))) return;

  // From here the notice is provably up, so every failure is real and must surface here.
  // Swallowing them is what left a full-screen overlay silently intercepting clicks and made
  // the spec fail later on an unrelated locator. Anchoring on the heading rather than the
  // button means a renamed button fails as "cannot click accept", not as a mystery timeout
  // three steps downstream.
  await page.getByRole("button", { name: /I understand, continue/i }).click();
  await notice.waitFor({ state: "detached", timeout: 10_000 });
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

/**
 * Waits for the execute page to be ready to take a signature.
 *
 * Deliberately not the panel heading. That heading is painted the moment `ExecutionWizard`
 * mounts, outside the `busy` branch, so asserting on it proves only that the route rendered -
 * it passes happily while the plan is still building, which makes it a gate that gates
 * nothing. The signer picker renders only in the non-busy branches, so it is the first thing
 * on the page that means what every call site here assumes.
 */
export async function expectSigningPanel(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: /Use secret key \(advanced\)/i })).toBeVisible({
    timeout: TESTNET_STEP_TIMEOUT,
  });
}

// Home -> analyze with ONLY the public key (the redesigned home no longer takes a
// destination). Lands on the analyze page once the plan preview has rendered.
export async function enterSourceAndAnalyze(page: Page, source: string): Promise<void> {
  await openTestnetHome(page);

  await enterSourceAddress(page, source);

  const analyzeButton = page.getByRole("button", { name: /Analyze account/i });
  await expect(analyzeButton).toBeEnabled();
  await analyzeButton.click();

  // Navigation only happens after the account-analysis API returns; that read hits
  // stellar.expert + RPC (and Horizon for open offers), which can exceed the default
  // 5s expect timeout for heavier accounts. Allow generous headroom.
  await expect(page).toHaveURL(/\/testnet\/analyze/, { timeout: 30_000 });
}

// Late-destination step: fills the destination, then "Begin execution" -> /review -> /execute.
export async function enterDestinationAndBegin(page: Page, destination: string): Promise<void> {
  const beginButton = page.getByRole("button", { name: /Begin execution/i });
  await expect(beginButton).toBeVisible({ timeout: 30_000 });

  await page.getByPlaceholder(/G\.\.\. \(where to send your XLM\)/).fill(destination);
  await confirmDestinationControl(page);

  await expect(beginButton).toBeEnabled();
  await beginButton.click();

  // Whole-plan review gate: the user must explicitly confirm before anything is built.
  await expect(page).toHaveURL(/\/testnet\/review/, { timeout: TESTNET_STEP_TIMEOUT });
  const proceedButton = page.getByRole("button", {
    name: /I understand this plan and want to proceed/i,
  });
  await expect(proceedButton).toBeDisabled({ timeout: TESTNET_STEP_TIMEOUT });

  // Explicit acknowledgment checkbox (the only checkbox on the review panel) gates the button.
  await page.getByRole("checkbox").check();
  await expect(proceedButton).toBeEnabled();
  await proceedButton.click();

  await expect(page).toHaveURL(/\/testnet\/execute/, { timeout: TESTNET_STEP_TIMEOUT });
}
