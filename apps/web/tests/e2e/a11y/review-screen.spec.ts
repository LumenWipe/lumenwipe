import { expect, test, type Page } from "@playwright/test";
import { Keypair } from "@stellar/stellar-sdk";
import { confirmDestinationControl } from "../helpers/destination";
import { enterSourceAndAnalyze } from "../helpers/flow";
import { installApiFixtures, OUTCOMES_ACCOUNT, OUTCOMES_ISSUER } from "./fixtures";

// The review leads with what the user consents to. Runs at the phone, tablet and desktop widths
// of this suite: the facts must fit each one without a sideways scroll.

async function toReview(
  page: Page,
  source: string,
  destination: string,
  decide: () => Promise<void> = async () => {}
): Promise<void> {
  await enterSourceAndAnalyze(page, source);
  await decide();
  await page.getByPlaceholder(/G\.\.\. \(where to send your XLM\)/).fill(destination);
  await confirmDestinationControl(page);
  await page.getByRole("button", { name: /Review the full plan/i }).click();
  await expect(page).toHaveURL(/\/testnet\/review/);
}

async function fitsWidth(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow, "horizontal scroll on /review").toBeLessThanOrEqual(0);
  // The bar clips what does not fit instead of scrolling, so its controls are measured too.
  const clipped = await page
    .getByRole("banner")
    .locator("a, button, span")
    .evaluateAll((els) =>
      els
        .filter((el) => el.getClientRects().length > 0)
        .filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth)
        .map((el) => el.textContent)
    );
  expect(clipped, "nav items past the right edge").toEqual([]);
}

test("the hero leads with both full addresses, the amount and the network", async ({ page }) => {
  const api = await installApiFixtures(page);
  const source = Keypair.random().publicKey();
  const destination = Keypair.random().publicKey();
  await toReview(page, source, destination);

  const hero = page.getByTestId("review-hero");
  await expect(hero).toBeVisible();
  const first = await hero.evaluate((el) => el.parentElement?.firstElementChild === el);
  expect(first, "the hero is the first content of the review").toBe(true);

  const groups = await hero
    .locator('[aria-hidden="true"]')
    .evaluateAll((els) => els.map((el) => el.textContent));
  expect(groups).toContain(source);
  expect(groups).toContain(destination);
  await expect(hero.getByTestId("hero-receive")).toContainText(
    /You will receive about\s*[\d.]+ XLM/
  );
  await expect(hero.getByTestId("memo-line")).toHaveText("none");

  await expect(page.getByText("TESTNET: no real value")).toBeVisible();
  await expect(page.getByRole("banner").getByText("TESTNET", { exact: true })).toBeVisible();
  await fitsWidth(page);

  api.expectAllAnswered();
});

test("each asset's outcome is listed from the choices made on analyze", async ({ page }) => {
  const api = await installApiFixtures(page);
  const destination = Keypair.random().publicKey();
  const friend = Keypair.random().publicKey();
  await toReview(page, OUTCOMES_ACCOUNT, destination, async () => {
    await page.getByRole("radio", { name: /Send .*EURC to another account/i }).check();
    await page.getByRole("textbox", { name: /Destination account for EURC/i }).fill(friend);
    await page.getByRole("button", { name: /^Claim balances/ }).click();
    await page.getByRole("button", { name: "Leave all unclaimed" }).click();
  });

  const rows = page.getByTestId("asset-outcome");
  await expect(rows).toHaveCount(3);
  const swap = rows.nth(0);
  const transfer = rows.nth(1);
  const forfeit = rows.nth(2);

  await expect(swap).toContainText("5 USDC");
  await expect(swap.getByTestId("asset-outcome-action")).toHaveText(
    /^Swapped to XLM: you receive at least [\d.]+ XLM \(the least the plan quoted\)\.$/
  );
  const issuer = await swap
    .locator('[aria-hidden="true"]')
    .evaluateAll((els) => els.map((el) => el.textContent));
  expect(issuer).toContain(OUTCOMES_ISSUER);

  await expect(transfer).toContainText("3 EURC");
  const sentTo = await transfer
    .locator('[aria-hidden="true"]')
    .evaluateAll((els) => els.map((el) => el.textContent));
  expect(sentTo).toContain(friend);

  await expect(forfeit).toContainText("Claimable 1.5 USDC");
  await expect(forfeit.getByTestId("asset-outcome-action")).toHaveText(
    /^Left unclaimed\. You are giving up 1\.5 USDC/
  );
  await expect(forfeit.getByText("Given up")).toBeVisible();

  const total = await page.getByTestId("net-estimate-total").locator("dd").textContent();
  await expect(page.getByTestId("hero-receive")).toContainText(total ?? "missing");
  await fitsWidth(page);

  api.expectAllAnswered();
});
