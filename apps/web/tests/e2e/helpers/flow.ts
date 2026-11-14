import { expect, type Locator, type Page } from "@playwright/test";
import { PLAN_REFRESH_FAILED } from "../../../lib/utils/user-error";
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

  // Absence is legitimate: the notice is decided from sessionStorage after hydration, so a
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
  const pasteAddress = page.getByRole("tab", { name: /Paste address/i });
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
 * did nothing" while the page still showed its loading label - the work was in flight,
 * not broken. Assertions on already-rendered DOM keep the short default on purpose, so a
 * genuine hang still fails fast rather than hiding behind a blanket timeout.
 */
export const TESTNET_STEP_TIMEOUT = 30_000;

/**
 * The API's own budget for one inbound request: `REQUEST_DEADLINE_MS` in
 * apps/api/src/config/constants.ts. Past it the API answers with a typed error, so a wait on one
 * request that is shorter than this gives up while the API is still within its own contract.
 */
const API_REQUEST_DEADLINE = 40_000;

/**
 * The longest the page waits after a busy answer (a 503) before its one automatic retry:
 * `BUSY_RETRY_MAX_WAIT_SECONDS` in apps/web/lib/api/busy-retry.ts, the API's own `Retry-After`.
 */
export const BUSY_RETRY_WAIT = 30_000;

/**
 * Budget for the account read and plan the analyze page makes on arrival: a busy answer at the
 * API's deadline, the wait, and the retry at the deadline, plus room for the page to render what
 * it read. Normal on testnet is 4.5 to 7.3 s; the deadline is what a slow upstream is allowed to
 * take, and a busy answer has so far come within 7 s.
 */
export const TESTNET_ANALYZE_TIMEOUT = 2 * API_REQUEST_DEADLINE + BUSY_RETRY_WAIT + 10_000;

/**
 * Budget for a step that waits on two sequential API requests: analyze -> review (the
 * destination check, then the plan), and review -> execute, where `refreshReviewedPlan` reads the
 * account and plans again before the page moves on. Two requests at the 40 s deadline is 80 s,
 * and one busy answer in the step adds the wait and one more request; the rest is navigation and
 * render. Normal on testnet is 6.4 to 7.5 s for analyze -> review and about 11 s for review ->
 * execute, so this only matters when an upstream is slow or busy.
 */
export const TESTNET_PLAN_TIMEOUT = 3 * API_REQUEST_DEADLINE + BUSY_RETRY_WAIT + 10_000;

/**
 * Where a finished testnet close lands: its saved receipt, or the completion page when the
 * receipt could not be saved or the close did not finish.
 */
export const CLOSE_FINISHED_URL = /\/testnet\/(?:complete|receipt\/[^/?#]+)$/;

/**
 * Reveals the secret-key field and fills it.
 *
 * Same wallet-first redesign as the source address: signing defaults to a connected wallet and
 * the key field sits behind "Use secret key (advanced)". Specs that drove the placeholder
 * directly stopped finding it. These specs sign with a throwaway testnet key, never a wallet.
 */
export async function enterSecretKey(page: Page, secret: string): Promise<void> {
  const useSecretKey = page.getByRole("tab", { name: /Use secret key \(advanced\)/i });
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
  await expect(page.getByRole("tab", { name: /Use secret key \(advanced\)/i })).toBeVisible({
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

  // The analyze page does the account read after this navigation, and that read hits
  // stellar.expert + RPC (and Horizon for open offers), which can take a while on testnet.
  await expect(page).toHaveURL(/\/testnet\/analyze/, { timeout: 30_000 });
  await expect(page.getByText("Analyzing account...")).toHaveCount(0, {
    timeout: TESTNET_ANALYZE_TIMEOUT,
  });
}

/**
 * Waits for a step that a refusal from the service can stop, and retries it once the way a user
 * would: with the page's own retry control.
 *
 * A refusal here is the page reporting a temporary upstream failure (a 503 while the data
 * provider is throttled), not the close path breaking, and the page offers the retry for exactly
 * that case. One retry absorbs one bad moment; a second refusal fails the test, so a service that
 * stays down is reported, never waited out.
 */
export async function untilDoneWithOneRetry(opts: {
  /** What the wait is for, named in the failure. */
  step: string;
  /** True once the step has finished. */
  done: () => boolean | Promise<boolean>;
  /** The page's refusal, visible when the step was refused. */
  refusal: Locator;
  /** The control the page offers to try the step again. */
  retry: Locator;
  timeout: number;
}): Promise<void> {
  const outcome = async (): Promise<"done" | "refused" | "pending"> =>
    (await opts.done()) ? "done" : (await opts.refusal.isVisible()) ? "refused" : "pending";

  await expect
    .poll(outcome, { timeout: opts.timeout, message: `${opts.step}: neither finished nor refused` })
    .not.toBe("pending");
  if ((await outcome()) === "done") return;

  await opts.retry.click();
  // The page clears its refusal when the retry starts, so a refusal seen after this is a new one.
  await expect(opts.refusal).toBeHidden();
  await expect
    .poll(outcome, { timeout: opts.timeout, message: `${opts.step}: neither finished nor refused` })
    .not.toBe("pending");
  expect(await outcome(), `${opts.step}: refused again after one retry`).toBe("done");
}

// Destination step: fills the destination, then "Review the full plan" -> /review -> /execute.
export async function enterDestinationAndBegin(page: Page, destination: string): Promise<void> {
  const beginButton = page.getByRole("button", { name: /Review the full plan/i });
  // The destination field is on screen from the start; the button unlocks once every item is decided.
  await expect(page.getByPlaceholder(/G\.\.\. \(where to send your XLM\)/)).toBeVisible({
    timeout: TESTNET_ANALYZE_TIMEOUT,
  });

  await page.getByPlaceholder(/G\.\.\. \(where to send your XLM\)/).fill(destination);
  await confirmDestinationControl(page);

  await expect(beginButton).toBeEnabled({ timeout: TESTNET_PLAN_TIMEOUT });
  await beginButton.click();

  // Whole-plan review gate: the user must explicitly confirm before anything is built.
  await expect(page).toHaveURL(/\/testnet\/review/, { timeout: TESTNET_PLAN_TIMEOUT });
  const proceedButton = page.getByRole("button", {
    name: /Continue to signing/i,
  });
  await expect(proceedButton).toBeDisabled({ timeout: TESTNET_STEP_TIMEOUT });

  // Explicit acknowledgment checkbox (the only checkbox on the review panel) gates the button.
  await page.getByRole("checkbox").check();
  await expect(proceedButton).toBeEnabled();
  await proceedButton.click();

  // Confirming plans again (`refreshReviewedPlan`) before it moves on. When that read is refused,
  // the page says so and offers "Try again", which re-runs the confirm with the consent given.
  const refusal = page.getByRole("alert").filter({ hasText: PLAN_REFRESH_FAILED });
  await untilDoneWithOneRetry({
    step: "review -> execute",
    done: () => /\/testnet\/execute/.test(page.url()),
    refusal,
    retry: refusal.getByRole("button", { name: "Try again" }),
    timeout: TESTNET_PLAN_TIMEOUT,
  });
}
