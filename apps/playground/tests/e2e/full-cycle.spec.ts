import { type Response } from "@playwright/test";
import { expect, test } from "./timed";
import { formatStroops, networkStroops } from "../../lib/stroops";
import { appAlerts } from "./alerts";
import { HORIZON } from "./testnet";

// The standard recipe end to end on testnet: create, mess, demolish through the real API, and the
// final merge into the playground's market maker, with nothing left on the closed account.

const BASE = "http://localhost:3002";

interface CreatedSession {
  sessionId: string;
  demoPublic: string;
  accounts: { mm: string };
}

/** The hashes a round response says it confirmed, read without trusting its shape. */
function confirmedHashes(body: unknown): string[] {
  if (typeof body !== "object" || body === null || !("confirmed" in body)) return [];
  if (!Array.isArray(body.confirmed)) return [];
  return body.confirmed.flatMap((tx: unknown) =>
    typeof tx === "object" && tx !== null && "hash" in tx && typeof tx.hash === "string"
      ? [tx.hash]
      : []
  );
}

const isDemolishRound = (res: Response): boolean => {
  const url = new URL(res.url());
  return (
    url.origin === BASE &&
    url.pathname.startsWith("/api/session/") &&
    url.pathname.endsWith("/demolish/round") &&
    res.request().method() === "POST"
  );
};

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
  // The polite status region repeats the summary for screen readers; this is the visible one.
  await expect(
    page.getByText("The account is now a mess").and(page.locator(":not([role=status])"))
  ).toBeVisible();
  await expect(appAlerts(page)).toHaveCount(0);

  // The close runs one round per request; each confirmed transaction appears in the activity log,
  // linked to the explorer, as its round returns.
  const firstRound = page.waitForResponse(isDemolishRound, { timeout: 3 * 60_000 });
  await demolish.click();
  const hashes = confirmedHashes(await (await firstRound).json());
  expect(hashes.length).toBeGreaterThan(0);
  // The log links a transaction only after the scene has played each of its operations.
  for (const hash of hashes) {
    await expect(
      page.getByRole("list", { name: "On-chain activity" }).locator(`a[href$="/tx/${hash}"]`)
    ).toHaveCount(1, { timeout: 60_000 });
  }
  await expect(page.getByText("demo complete. The account was merged away")).toBeVisible({
    timeout: 3 * 60_000,
  });
  await expect(appAlerts(page)).toHaveCount(0);

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

  // The receipt's figures are the ledger's: each fee as Horizon reports it charged, and the merge
  // as the amount the market maker was credited, read here without the receipt's own parser.
  const receipt = page.getByRole("region", { name: "Receipt" });
  await expect(receipt.getByText(/XLM paid by/)).toBeVisible({ timeout: 60_000 });
  const linked = await receipt
    .locator('a[href*="/tx/"]')
    .evaluateAll((links) => links.map((a) => a.getAttribute("href")?.split("/tx/")[1] ?? ""));
  let byAccount = BigInt(0);
  let bySponsor = BigInt(0);
  let credited: string | null = null;
  for (const hash of linked) {
    const tx = (await (await fetch(`${HORIZON}/transactions/${hash}`)).json()) as {
      hash: string;
      fee_charged: string;
      fee_account: string;
    };
    if (tx.fee_account === session.demoPublic) byAccount += BigInt(tx.fee_charged);
    else bySponsor += BigInt(tx.fee_charged);
    const effects = (await (
      await fetch(`${HORIZON}/transactions/${tx.hash}/effects?limit=200`)
    ).json()) as {
      _embedded: { records: { type: string; account?: string; amount?: string }[] };
    };
    const merge = effects._embedded.records.find(
      (e) => e.type === "account_credited" && e.account === session.accounts.mm
    );
    if (merge?.amount) credited = merge.amount;
  }
  expect(credited).not.toBeNull();
  await expect(
    receipt.getByText(`${xlm(networkStroops(credited!))} XLM`, { exact: true })
  ).toBeVisible();
  if (byAccount > BigInt(0)) {
    await expect(receipt.getByText(`${xlm(byAccount)} XLM paid by the demo account`)).toBeVisible();
  }
  if (bySponsor > BigInt(0)) {
    await expect(
      receipt.getByText(`${xlm(bySponsor)} XLM paid by LumenWipe's fee sponsor`)
    ).toBeVisible();
  }
});

/** XLM as the receipt prints it: seven decimals with trailing zeros dropped. */
function xlm(stroops: bigint): string {
  const [whole, fraction = ""] = formatStroops(stroops).split(".");
  const trimmed = fraction.replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : `${whole}`;
}
