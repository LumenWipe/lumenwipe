import { expect, test, type Page, type Response } from "@playwright/test";
import { encodeSelection, type ScenarioSelection } from "../../lib/scenarios";
import { appAlerts } from "./alerts";
import { HORIZON } from "./testnet";

// The claimable-balance and sponsored-reserve scenarios end to end on testnet, including the
// blocker-then-resolve story: a balance the demo created, or a sponsorship its beneficiary cannot
// take over, stops the close with a blocker card; "Resolve it" clears it with the helper's own key
// and the close completes into the market maker.

const BASE = "http://localhost:3002";

interface CreatedSession {
  demoPublic: string;
  accounts: { mm: string };
}

interface HorizonOperation {
  type: string;
  account?: string;
  into?: string;
}

const isCreateSession = (res: Response): boolean => {
  const url = new URL(res.url());
  return (
    url.origin === BASE && url.pathname === "/api/session" && res.request().method() === "POST"
  );
};

async function operationsOf(account: string): Promise<HorizonOperation[]> {
  const res = await fetch(`${HORIZON}/accounts/${account}/operations?order=asc&limit=200`);
  if (!res.ok) return [];
  const body = (await res.json()) as { _embedded: { records: HorizonOperation[] } };
  return body._embedded.records;
}

/** Runs a selection to the merge, resolving the blocker on the way when one is expected.
 *  `scenario` is the picker label the shared link must turn on before the run starts. */
async function closeWith(
  page: Page,
  selection: ScenarioSelection,
  scenario: string,
  blocker: RegExp | null
): Promise<{ session: CreatedSession; ops: HorizonOperation[] }> {
  await page.goto(`/?selection=${encodeSelection(selection)}`);
  await expect(page.getByRole("button", { name: scenario, pressed: true })).toBeVisible();
  const created = page.waitForResponse(isCreateSession, { timeout: 90_000 });
  await page.getByRole("button", { name: "Create & trash a demo account" }).click();
  const response = await created;
  expect(response.status()).toBe(200);
  const session = (await response.json()) as CreatedSession;

  await page.getByRole("button", { name: "Demolish it here" }).click({ timeout: 6 * 60_000 });
  if (blocker) {
    const card = page.getByRole("list", { name: "Blockers" });
    await expect(card).toBeVisible({ timeout: 3 * 60_000 });
    await expect(card).toContainText(blocker);
    await card.getByRole("button", { name: "Resolve it" }).click();
  }
  await expect(page.getByText("demo complete. The account was merged away")).toBeVisible({
    timeout: 4 * 60_000,
  });
  await expect(appAlerts(page)).toHaveCount(0);
  await expect
    .poll(async () => (await fetch(`${HORIZON}/accounts/${session.demoPublic}`)).status, {
      timeout: 60_000,
    })
    .toBe(404);
  const ops = await operationsOf(session.demoPublic);
  expect(ops[ops.length - 1]).toEqual(
    expect.objectContaining({
      type: "account_merge",
      account: session.demoPublic,
      into: session.accounts.mm,
    })
  );
  return { session, ops };
}

const count = (ops: HorizonOperation[], type: string): number =>
  ops.filter((op) => op.type === type).length;

test("claimable balances: claim, add a trustline then claim, forfeit, and resolve the one the demo created", async ({
  page,
}) => {
  test.setTimeout(12 * 60_000);
  const { ops } = await closeWith(
    page,
    {
      scenarios: [
        {
          id: "claimable-balances",
          params: { add_trustline: 1, time_gated: 1, demo_sponsored: 1 },
        },
      ],
    },
    "Claimable balances",
    /claimable balance for another account/
  );
  // The two balances the demo can claim now; the time-gated one is forfeited.
  expect(count(ops, "claim_claimable_balance")).toBe(2);
});

for (const [variant, label, blocker, revokes] of [
  [0, "a sponsor pays the demo's reserves", null, 0],
  [1, "the demo's sponsorships are revoked", null, 2],
  [2, "an unrevocable sponsorship is resolved by its beneficiary", /cannot afford/, 0],
] as const) {
  test(`sponsored reserves: ${label}`, async ({ page }) => {
    test.setTimeout(10 * 60_000);
    const { ops } = await closeWith(
      page,
      { scenarios: [{ id: "sponsored-reserves", params: { variant } }] },
      "Sponsored reserves",
      blocker
    );
    expect(count(ops, "revoke_sponsorship")).toBe(revokes);
  });
}
