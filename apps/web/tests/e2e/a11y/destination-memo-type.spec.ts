import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { Keypair } from "@stellar/stellar-sdk";
import { enterSourceAndAnalyze } from "../helpers/flow";
import { expectNoAxeViolations } from "./axe";
import { installApiFixtures } from "./fixtures";

const bundled = JSON.parse(
  readFileSync(resolve(__dirname, "../../../../api/src/config/exchange-registry.json"), "utf8")
) as { entries: unknown[]; lastVerified: string; validUntil: string };

// An exchange only the served registry lists has its memo type stated by the user, never taken
// from the served copy, and a choice the served copy disagrees with is blocked on the page.
test("the memo type of an exchange only the served registry lists", async ({ page }) => {
  const api = await installApiFixtures(page);
  const exchange = Keypair.random().publicKey();
  // Registered after the fixtures, so it answers the registry route in their place.
  await page.route("**/api/config/exchange-registry", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...bundled,
        entries: [
          ...bundled.entries,
          {
            address: exchange,
            name: "Newly Listed",
            domain: "example.com",
            requiresMediator: false,
            requiresMemo: true,
            memoType: "id",
          },
        ],
      }),
    })
  );

  await enterSourceAndAnalyze(page, Keypair.random().publicKey());
  await page.getByPlaceholder(/G\.\.\. \(where to send your XLM\)/).fill(exchange);

  const memoType = page.getByRole("group", { name: "Memo type" });
  await expect(
    memoType.getByText(/Check the memo type on Newly Listed's deposit page/)
  ).toBeVisible();
  await expect(memoType.getByRole("radio", { name: "Text" })).not.toBeChecked();
  await expect(memoType.getByRole("radio", { name: "ID (numbers only)" })).not.toBeChecked();
  await expectNoAxeViolations(page, "plan, memo type not chosen");

  await memoType.getByRole("radio", { name: "Text" }).check();
  await page.getByRole("textbox", { name: /Payment memo/ }).fill("4411");
  await expect(memoType.getByRole("alert")).toContainText(
    "Newly Listed's deposit rules list a numeric memo, not the text memo you chose."
  );
  await expect(page.getByRole("button", { name: /Review the full plan/i })).toBeDisabled();
  await expectNoAxeViolations(page, "plan, memo type the served rules disagree with");

  await memoType.getByRole("radio", { name: "ID (numbers only)" }).check();
  await expect(memoType.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Review the full plan/i })).toBeEnabled();
  await expectNoAxeViolations(page, "plan, memo type chosen");
  api.expectAllAnswered();
});
