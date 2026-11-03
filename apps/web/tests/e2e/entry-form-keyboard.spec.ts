import { expect, test } from "@playwright/test";
import { Keypair } from "@stellar/stellar-sdk";
import { enterSourceAddress, openTestnetHome } from "./helpers/flow";

const ADDRESS = Keypair.random().publicKey();

test("the entry form switch works with the keyboard alone", async ({ page }) => {
  await openTestnetHome(page);

  const wallet = page.getByRole("tab", { name: "Connect wallet" });
  const paste = page.getByRole("tab", { name: "Paste address" });
  const field = page.getByPlaceholder("G... (the account to merge)");

  await page.locator("body").evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let presses = 0; presses < 40; presses++) {
    await page.keyboard.press("Tab");
    if (await wallet.evaluate((el) => el === document.activeElement)) break;
  }
  await expect(wallet).toBeFocused();
  await expect(wallet).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("ArrowRight");
  await expect(paste).toBeFocused();
  await expect(paste).toHaveAttribute("aria-selected", "true");
  await expect(field).toBeVisible();

  await page.keyboard.press("Tab");
  await expect(field).toBeFocused();
  await page.keyboard.type(ADDRESS);
  await expect(field).toHaveValue(ADDRESS);

  await page.keyboard.press("Shift+Tab");
  await expect(paste).toBeFocused();
  await page.keyboard.press("Home");
  await expect(wallet).toBeFocused();
  await expect(wallet).toHaveAttribute("aria-selected", "true");
  await expect(field).toBeHidden();

  await page.keyboard.press("End");
  await expect(paste).toBeFocused();
  await expect(field).toHaveValue(ADDRESS);

  await page.keyboard.press("ArrowLeft");
  await expect(wallet).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(paste).toHaveAttribute("aria-selected", "true");
});

test("the shared entry helper reaches the address field through the switch", async ({ page }) => {
  await openTestnetHome(page);
  await enterSourceAddress(page, ADDRESS);
  await expect(page.getByPlaceholder("G... (the account to merge)")).toHaveValue(ADDRESS);
});
