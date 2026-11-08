import { expect, test } from "@playwright/test";
import { expectNoAxeViolations } from "./axe";
import { COSIGN_ACCOUNT, cosignRequestEnvelope, installApiFixtures } from "./fixtures";

let api: Awaited<ReturnType<typeof installApiFixtures>>;

test.beforeEach(async ({ page }) => {
  api = await installApiFixtures(page);
});

test.afterEach(() => api.expectAllAnswered());

test("cosign station", async ({ page }) => {
  // The title comes from server metadata, so it is already in the HTML the server sends.
  const html = await (await page.request.get("/cosign")).text();
  expect(html).toMatch(/<title[^>]*>Cosign a transaction \| LumenWipe<\/title>/);

  await page.goto("/cosign");
  await expect(page.getByRole("heading", { level: 1, name: "Cosign a transaction" })).toBeVisible();
  await expectNoAxeViolations(page, "cosign, empty");

  await page.getByRole("radio", { name: "Testnet" }).check();
  await page.getByRole("textbox", { name: /Account to cosign for/ }).fill(COSIGN_ACCOUNT);
  const pasted = page.getByRole("textbox", { name: /Or paste the request/ });
  await expect(pasted).toBeVisible();
  await expectNoAxeViolations(page, "cosign, account read");

  await pasted.fill("{}");
  await page.getByRole("button", { name: "Check request" }).click();
  await expect(page.getByText("This cosign file is missing a field.")).toBeVisible();
  await expectNoAxeViolations(page, "cosign, refused request");

  await pasted.fill(
    JSON.stringify({
      format: "lumenwipe-cosign",
      version: 1,
      direction: "request",
      network: "testnet",
      account: COSIGN_ACCOUNT,
      envelope: cosignRequestEnvelope(),
    })
  );
  await page.getByRole("button", { name: "Check request" }).click();
  await expect(page.getByText(/sole control of this account/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign this transaction" })).toBeDisabled();
  await page.getByRole("textbox", { name: /Transaction hash characters/ }).fill("0000000000000000");
  await expect(page.getByText(/The characters do not match/)).toBeVisible();
  await expectNoAxeViolations(page, "cosign, checked request");

  await page.getByRole("tab", { name: "Secret key" }).click();
  await expect(page.getByRole("button", { name: "Use a secret key anyway" })).toBeVisible();
  await expectNoAxeViolations(page, "cosign, secret key warning");
});
