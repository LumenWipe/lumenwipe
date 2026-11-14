import { expect, type Page, type Response } from "@playwright/test";
import { encodeSelection, type ScenarioSelection } from "../../lib/scenarios";
import { appAlerts } from "./alerts";
import { HORIZON } from "./testnet";

// Runs a scenario selection from a shared link to the merge, as a visitor would, and reads back
// what landed on the demo account. Shared by the scenario specs.

const BASE = "http://localhost:3002";

export interface CreatedSession {
  demoPublic: string;
  accounts: {
    mm: string;
    /** Where an exchange session deposits, and with which memo; null for any other. */
    exchange: { destination: string; memo: string; memoType: "id" } | null;
  };
}

export interface HorizonOperation {
  type: string;
  account?: string;
  into?: string;
  signer_key?: string;
  signer_weight?: number;
  low_threshold?: number;
  med_threshold?: number;
  high_threshold?: number;
}

const isCreateSession = (res: Response): boolean => {
  const url = new URL(res.url());
  return (
    url.origin === BASE && url.pathname === "/api/session" && res.request().method() === "POST"
  );
};

export async function operationsOf(account: string): Promise<HorizonOperation[]> {
  const res = await fetch(`${HORIZON}/accounts/${account}/operations?order=asc&limit=200`);
  if (!res.ok) return [];
  const body = (await res.json()) as { _embedded: { records: HorizonOperation[] } };
  return body._embedded.records;
}

/** Runs a selection to the merge, resolving the blocker on the way when one is expected.
 *  `scenario` is the picker label the shared link must turn on before the run starts, and
 *  `mergeInto` the account the demo is merged into (the market maker unless the test says). */
export async function closeWith(
  page: Page,
  selection: ScenarioSelection,
  scenario: string,
  blocker: RegExp | null,
  mergeInto: (session: CreatedSession) => string = (session) => session.accounts.mm
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
      into: mergeInto(session),
    })
  );
  return { session, ops };
}

export const count = (ops: HorizonOperation[], type: string): number =>
  ops.filter((op) => op.type === type).length;
