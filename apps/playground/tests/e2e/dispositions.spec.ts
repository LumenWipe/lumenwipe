import { expect, test, type Response } from "@playwright/test";
import { encodeSelection, type ScenarioSelection } from "../../lib/scenarios";
import { appAlerts } from "./alerts";
import { HORIZON } from "./testnet";

// The dispositions scenario end to end on testnet: each of its two tokens is burned (returned to
// the persistent issuer), converted to XLM through the market maker's standing offer, or sent to
// the session's own recipient, and the close then merges the demo into the market maker. Between
// the two runs every disposition is exercised.

const BASE = "http://localhost:3002";

interface CreatedSession {
  demoPublic: string;
  accounts: { issuer: string; mm: string; transferRecipient: string | null };
}

interface HorizonOperation {
  type: string;
  from?: string;
  to?: string;
  asset_code?: string;
  source_asset_code?: string;
  account?: string;
  into?: string;
}

const isCreateSession = (res: Response): boolean => {
  const url = new URL(res.url());
  return (
    url.origin === BASE && url.pathname === "/api/session" && res.request().method() === "POST"
  );
};

/** The closed account's operations, oldest first. */
async function operationsOf(account: string): Promise<HorizonOperation[]> {
  const res = await fetch(`${HORIZON}/accounts/${account}/operations?order=asc&limit=200`);
  if (!res.ok) return [];
  const body = (await res.json()) as { _embedded: { records: HorizonOperation[] } };
  return body._embedded.records;
}

type Choice = "burn" | "convert" | "transfer";
const PARAM: Record<Choice, number> = { burn: 0, convert: 1, transfer: 2 };

for (const choices of [
  { LWCOIN: "convert", LWGEM: "transfer" },
  { LWCOIN: "transfer", LWGEM: "burn" },
] as const satisfies readonly Record<"LWCOIN" | "LWGEM", Choice>[]) {
  test(`LWCOIN ${choices.LWCOIN} and LWGEM ${choices.LWGEM} close the demo account`, async ({
    page,
  }) => {
    test.setTimeout(10 * 60_000);
    const selection: ScenarioSelection = {
      scenarios: [
        {
          id: "dispositions",
          params: { lwcoin: PARAM[choices.LWCOIN], lwgem: PARAM[choices.LWGEM] },
        },
      ],
    };
    await page.goto(`/?selection=${encodeSelection(selection)}`);
    // The link is applied before the run can start; the default wallet has no dispositions.
    await expect(
      page.getByRole("button", { name: "Convert, transfer or burn", pressed: true })
    ).toBeVisible();

    const created = page.waitForResponse(isCreateSession, { timeout: 90_000 });
    await page.getByRole("button", { name: "Create & trash a demo account" }).click();
    const response = await created;
    expect(response.status()).toBe(200);
    const session = (await response.json()) as CreatedSession;
    expect(session.accounts.transferRecipient).not.toBeNull();

    await page.getByRole("button", { name: "Demolish it here" }).click({ timeout: 6 * 60_000 });
    await expect(page.getByText("demo complete. The account was merged away")).toBeVisible({
      timeout: 3 * 60_000,
    });
    await expect(appAlerts(page)).toHaveCount(0);

    await expect
      .poll(async () => (await fetch(`${HORIZON}/accounts/${session.demoPublic}`)).status, {
        timeout: 60_000,
      })
      .toBe(404);

    // How each token left the demo account, from the chain itself.
    const ops = await operationsOf(session.demoPublic);
    const left = (code: string): string | undefined => {
      const conversion = ops.find(
        (op) => op.type === "path_payment_strict_send" && op.source_asset_code === code
      );
      if (conversion) return "convert";
      const payment = ops.find(
        (op) => op.type === "payment" && op.from === session.demoPublic && op.asset_code === code
      );
      if (payment?.to === session.accounts.issuer) return "burn";
      if (payment?.to === session.accounts.transferRecipient) return "transfer";
      return undefined;
    };
    expect({ LWCOIN: left("LWCOIN"), LWGEM: left("LWGEM") }).toEqual(choices);
    expect(ops[ops.length - 1]).toEqual(
      expect.objectContaining({
        type: "account_merge",
        account: session.demoPublic,
        into: session.accounts.mm,
      })
    );
  });
}
