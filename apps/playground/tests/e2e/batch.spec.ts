import { expect, test, type Response } from "@playwright/test";
import { appAlerts } from "./alerts";
import { operationsOf } from "./close-with";
import { HORIZON } from "./testnet";

// The batch close end to end on testnet: three demo accounts, one call to the API's batch plan,
// then each close in turn. The account the server adds holds a claimable balance it created, so
// the plan and its close report it blocked while the other two merge into the market maker; it is
// reported, not skipped, and "Resolve it" then closes it too, leaving nothing for the reaper.

const BASE = "http://localhost:3002";

interface CreatedBatch {
  blockedIndex: number;
  members: { demoPublic: string; accounts: { mm: string } }[];
}

const isCreateBatch = (res: Response): boolean => {
  const url = new URL(res.url());
  return url.origin === BASE && url.pathname === "/api/batch" && res.request().method() === "POST";
};

const accountStatus = async (address: string): Promise<number> =>
  (await fetch(`${HORIZON}/accounts/${address}`)).status;

async function expectMergedInto(address: string, into: string): Promise<void> {
  await expect.poll(() => accountStatus(address), { timeout: 60_000 }).toBe(404);
  const ops = await operationsOf(address);
  expect(ops[ops.length - 1]).toEqual(
    expect.objectContaining({ type: "account_merge", account: address, into })
  );
}

test("a batch closes every account it can, reports the blocked one, then resolves it", async ({
  page,
}) => {
  test.setTimeout(15 * 60_000);
  await page.goto("/?batch=3");
  await expect(page.getByRole("button", { name: "A batch of 3", pressed: true })).toBeVisible();
  const created = page.waitForResponse(isCreateBatch, { timeout: 90_000 });
  await page.getByRole("button", { name: "Create & trash 3 demo accounts" }).click();
  const response = await created;
  expect(response.status()).toBe(200);
  const batch = (await response.json()) as CreatedBatch;
  expect(batch.members).toHaveLength(3);
  expect(batch.blockedIndex).toBe(2);
  const mm = batch.members[0]!.accounts.mm;

  // The plan: the blocked account is named with its blocker before anything is closed.
  await page.getByRole("button", { name: "Close every account" }).click({ timeout: 8 * 60_000 });
  const blocked = page.getByRole("listitem", { name: "Account 3" });
  await expect(blocked).toContainText("blocked on purpose");
  await expect(blocked).toContainText(/claimable balance for another account/);

  await expect(page.getByText(/Batch complete: 2 of 3 accounts merged away/)).toBeVisible({
    timeout: 5 * 60_000,
  });
  for (const member of batch.members.slice(0, 2)) await expectMergedInto(member.demoPublic, mm);
  // Reported, not skipped: still open, with its blocker on the page.
  await expect(blocked).toContainText("Not closed: blocked");
  expect(await accountStatus(batch.members[2]!.demoPublic)).toBe(200);

  await blocked.getByRole("button", { name: "Resolve it" }).click();
  await expect(blocked).toContainText("Merged into the market maker", { timeout: 4 * 60_000 });
  await expectMergedInto(batch.members[2]!.demoPublic, mm);
  await expect(appAlerts(page)).toHaveCount(0);
});
