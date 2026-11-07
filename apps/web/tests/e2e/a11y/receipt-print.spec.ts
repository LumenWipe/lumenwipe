import { expect, test } from "@playwright/test";
import { installApiFixtures } from "./fixtures";
import { closedReceipt, openSeededReceipt } from "../helpers/receipt";

// The receipt prints as a plain document: everything a reader needs to check the close on an
// explorer, whole, and nothing to click. Here with the accessibility gate, not the testnet suite:
// the receipt is seeded into IndexedDB and every API call is a fixture, so it runs on each PR.
test("the printed receipt has every hash, URL and the destination, and no chrome", async ({
  page,
}) => {
  const api = await installApiFixtures(page);
  const record = closedReceipt();
  await openSeededReceipt(page, record);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Account successfully merged");
  await expect(page.getByRole("banner")).toBeVisible();
  await expect(page.locator("#app-root button:visible").first()).toBeVisible();

  await page.emulateMedia({ media: "print" });

  await expect(page.getByRole("banner")).toBeHidden();
  await expect(page.getByRole("navigation")).toHaveCount(0);
  // The app's own page only: the dev server's overlay is not part of it.
  await expect(page.locator("#app-root button:visible")).toHaveCount(0);
  await expect(page.locator("#app-root a:visible")).toHaveCount(0);

  // As printed: the receipt's rendered text, with what print hides left out.
  const paper = (await page.locator("[data-receipt]").innerText()).replace(/\s+/g, "");
  expect(paper).toContain(record.destinationAddress);
  expect(paper).toContain(record.sourceAddress);
  for (const { txHash } of record.transactions) {
    expect(paper).toContain(txHash);
    expect(paper).toContain(`https://stellar.expert/explorer/testnet/tx/${txHash}`);
    expect(paper).not.toContain(`${txHash.slice(0, 6)}…${txHash.slice(-6)}`);
  }
  for (const group of record.groups ?? []) {
    for (const item of group.items) expect(paper).toContain(item.text.replace(/\s+/g, ""));
  }

  // Black on white, and nothing wider than the page.
  const ink = await page
    .locator("[data-receipt] p")
    .first()
    .evaluate((el) => getComputedStyle(el).color);
  expect(ink).toBe("rgb(0, 0, 0)");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  );

  api.expectAllAnswered();
});
