import { expect, test, type Response } from "@playwright/test";
import { HORIZON } from "./testnet";

// The standard recipe end to end on testnet: create, mess, demolish through the real API, and the
// final merge into the playground's market maker, with nothing left on the closed account.

const BASE = "http://localhost:3002";

interface CreatedSession {
  sessionId: string;
  demoPublic: string;
  accounts: { mm: string };
}

const isCreateSession = (res: Response): boolean => {
  const url = new URL(res.url());
  return (
    url.origin === BASE && url.pathname === "/api/session" && res.request().method() === "POST"
  );
};

test("the standard recipe closes the demo account into the market maker", async ({ page }) => {
  test.setTimeout(10 * 60_000);
  await page.goto("/");

  const created = page.waitForResponse(isCreateSession, { timeout: 90_000 });
  await page.getByRole("button", { name: "Create & trash a demo account" }).click();
  const response = await created;
  expect(response.status()).toBe(200);
  const session = (await response.json()) as CreatedSession;

  // Mess: every step of the plan lands, and the account now holds subentries.
  const demolish = page.getByRole("button", { name: "Demolish it here" });
  await expect(demolish).toBeVisible({ timeout: 6 * 60_000 });
  await expect(page.getByText("The account is now a mess")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);

  await demolish.click();
  await expect(page.getByText("demo complete. The account was merged away")).toBeVisible({
    timeout: 3 * 60_000,
  });
  await expect(page.getByRole("alert")).toHaveCount(0);

  // The account no longer exists, so no trustline, offer, data entry or signer is left on it.
  await expect
    .poll(async () => (await fetch(`${HORIZON}/accounts/${session.demoPublic}`)).status, {
      timeout: 60_000,
    })
    .toBe(404);

  // Its last operation is the merge into the playground's market maker.
  const lastOp = async (): Promise<{ type?: string; account?: string; into?: string }> => {
    const res = await fetch(
      `${HORIZON}/accounts/${session.demoPublic}/operations?order=desc&limit=1`
    );
    if (!res.ok) return {};
    const body = (await res.json()) as {
      _embedded: { records: { type: string; account?: string; into?: string }[] };
    };
    return body._embedded.records[0] ?? {};
  };
  await expect.poll(lastOp, { timeout: 60_000 }).toEqual(
    expect.objectContaining({
      type: "account_merge",
      account: session.demoPublic,
      into: session.accounts.mm,
    })
  );
});
