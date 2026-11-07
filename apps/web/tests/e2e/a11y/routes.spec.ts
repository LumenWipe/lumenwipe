import { expect, test } from "@playwright/test";
import { Keypair } from "@stellar/stellar-sdk";
import { dismissRiskModal, enterSourceAddress, openTestnetHome } from "../helpers/flow";
import { closedReceipt, openSeededReceipt } from "../helpers/receipt";
import { expectNoAxeViolations } from "./axe";
import { FLAGGED_TOKEN_ACCOUNT, installApiFixtures, UNRENDERABLE_ACCOUNT } from "./fixtures";

let api: Awaited<ReturnType<typeof installApiFixtures>>;

test.beforeEach(async ({ page }) => {
  api = await installApiFixtures(page);
});

test.afterEach(() => api.expectAllAnswered());

test("home", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "Stellar account address" })).toBeVisible();
  await expectNoAxeViolations(page, "home");
});

test("entry", async ({ page }) => {
  await openTestnetHome(page);
  await expect(page.getByRole("tab", { name: "Connect wallet" })).toBeVisible();
  await expectNoAxeViolations(page, "entry, wallet mode");

  await enterSourceAddress(page, Keypair.random().publicKey());
  await expect(page.getByRole("textbox", { name: "Account to close" })).toBeVisible();
  await expectNoAxeViolations(page, "entry, address mode");
});

test("allowances", async ({ page }) => {
  await page.goto("/testnet/allowances");
  await dismissRiskModal(page);
  await page.getByPlaceholder(/G\.\.\./).fill(Keypair.random().publicKey());
  await page.getByRole("button", { name: /Inspect/ }).click();
  await expect(page.getByRole("status").filter({ hasText: /allowance/i })).toBeVisible();
  await expectNoAxeViolations(page, "allowances");
});

test("history", async ({ page }) => {
  await openTestnetHome(page);
  await page.getByRole("button", { name: "Merge history" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expectNoAxeViolations(page, "history");
});

test("receipt not in this browser", async ({ page }) => {
  await page.goto("/testnet/receipt/not-saved-here");
  await dismissRiskModal(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Receipt not found in this browser"
  );
  await expectNoAxeViolations(page, "receipt not in this browser");
});

test("receipt saved in this browser", async ({ page }) => {
  await openSeededReceipt(page, closedReceipt());
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Account successfully merged");
  await expectNoAxeViolations(page, "receipt, groups collapsed");

  await page.getByRole("button", { name: /Offers cancelled/ }).click();
  await page.getByRole("button", { name: "Show full hash of Merge" }).click();
  await expectNoAxeViolations(page, "receipt, a group and a hash open");
});

test("not found", async ({ page }) => {
  await page.goto("/no-such-page");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("This page has");
  await expectNoAxeViolations(page, "not found");
});

test("error", async ({ page }) => {
  // Relies on UNRENDERABLE_ACCOUNT: its `trustlines` is not a list, so the analyze page throws
  // while rendering it. If the page ever renders that account, this heading assertion fails and
  // the error page needs another way in; it must not be dropped from the scan.
  await page.goto(`/testnet/analyze?source=${UNRENDERABLE_ACCOUNT}`);
  await dismissRiskModal(page);
  await expect(page.getByRole("heading", { name: "Something went wrong" })).toBeVisible();
  await expectNoAxeViolations(page, "error");
});

test("analyze, a token conversion that needs a confirmation", async ({ page }) => {
  await page.goto(`/testnet/analyze?source=${FLAGGED_TOKEN_ACCOUNT}`);
  await dismissRiskModal(page);
  await page.getByRole("radio", { name: /Exchange my 250 XTAR for XLM/ }).check();
  await expect(
    page.getByRole("checkbox", { name: /still want to exchange my 250 XTAR/ })
  ).toBeVisible();
  await expectNoAxeViolations(page, "analyze, flagged token conversion");
});
