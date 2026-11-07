import { expect, test } from "@playwright/test";
import { Keypair } from "@stellar/stellar-sdk";
import { confirmDestinationControl } from "../helpers/destination";
import { enterSecretKey, enterSourceAndAnalyze, expectSigningPanel } from "../helpers/flow";
import { expectNoAxeViolations } from "./axe";
import { installApiFixtures } from "./fixtures";

// The close screens hold their state in memory only, so they are reached by walking the flow.
// Every call is a fixture: the signed merge is handed to a stand-in submit and never sent.
test("analyze, review, execute, complete and history", async ({ page }) => {
  const api = await installApiFixtures(page);
  const source = Keypair.random();

  await enterSourceAndAnalyze(page, source.publicKey());
  await expect(
    page.getByRole("heading", { level: 1, name: "Decide what happens to each item" })
  ).toBeVisible();
  await expectNoAxeViolations(page, "analyze");

  await page
    .getByPlaceholder(/G\.\.\. \(where to send your XLM\)/)
    .fill(Keypair.random().publicKey());
  await confirmDestinationControl(page);
  await page.getByRole("button", { name: /Review the full plan/i }).click();
  await expect(page).toHaveURL(/\/testnet\/review/);
  await expect(page.getByRole("heading", { level: 1, name: "Review the full plan" })).toBeVisible();
  await expectNoAxeViolations(page, "review");

  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: /I understand this plan and want to proceed/i }).click();
  await expect(page).toHaveURL(/\/testnet\/execute/);
  await expectSigningPanel(page);
  await expectNoAxeViolations(page, "execute, wallet signer");

  await page.getByRole("tab", { name: /Use secret key \(advanced\)/i }).click();
  const field = page.getByPlaceholder("S...");
  const reveal = page.getByRole("button", { name: "Show secret key" });
  await field.pressSequentially("not a key");
  await page.keyboard.press("Tab");
  await expect(reveal).toBeFocused();
  await expect(reveal).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Space");
  await expect(field).toHaveAttribute("type", "text");
  await expect(reveal).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Enter");
  await expect(field).toHaveAttribute("type", "password");
  await expect(reveal).toHaveAttribute("aria-pressed", "false");
  await expectNoAxeViolations(page, "execute, secret key field");

  await enterSecretKey(page, source.secret());
  await expect(page.getByText("Secret key loaded for this session")).toBeVisible();
  await expectNoAxeViolations(page, "execute, key loaded");

  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: /Sign & execute close/i }).click();
  await expect(page).toHaveURL(/\/testnet\/complete/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expectNoAxeViolations(page, "complete");

  await page.getByRole("button", { name: "Merge history" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expectNoAxeViolations(page, "history, after a close");

  api.expectAllAnswered();
});
