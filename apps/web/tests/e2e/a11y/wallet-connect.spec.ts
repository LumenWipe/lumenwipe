import { expect, test } from "@playwright/test";
import { openTestnetHome } from "../helpers/flow";
import { installApiFixtures } from "./fixtures";

// The a11y build carries the all-zero placeholder project id (see `test:a11y`), so WalletConnect
// is configured; the fixtures refuse every request and socket to its hosts.
test("the wallet picker offers WalletConnect when the build has a project id", async ({ page }) => {
  const api = await installApiFixtures(page);
  await openTestnetHome(page);
  await expect(page.getByRole("tab", { name: "Connect wallet" })).toBeVisible();
  await expect(page.getByText(/need WalletConnect, which is not set up/)).toHaveCount(0);

  await page
    .getByRole("button", { name: /Connect wallet/i })
    .last()
    .click();
  await expect(page.getByText("WalletConnect", { exact: true })).toBeVisible();
  api.expectAllAnswered();
});
