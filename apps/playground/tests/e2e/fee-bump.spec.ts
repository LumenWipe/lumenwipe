import { expect, test } from "@playwright/test";
import { Keypair } from "@stellar/stellar-sdk";
import { closeWith } from "./close-with";
import { HORIZON } from "./testnet";

// The sponsored fee end to end on testnet: the demo's last mess step drains it to less than one
// close fee above its reserve floor, so the API builds the close with its own fee at zero, and the
// merge lands inside a fee-bump envelope paid by the API's fee account (generated for this run by
// playwright.config.ts), which the playground checked before sending it.

interface HorizonTransaction {
  hash: string;
  source_account: string;
  fee_account: string;
  fee_charged: string;
  inner_transaction?: { hash: string; max_fee: string };
}

interface PaymentOperation {
  type: string;
  from?: string;
  to?: string;
  asset_type?: string;
}

const feeAccount = (): string => {
  const secret = process.env.PLAYGROUND_E2E_FEE_SECRET;
  if (!secret) throw new Error("playwright.config.ts sets the run's fee account");
  return Keypair.fromSecret(secret).publicKey();
};

test("a drained demo closes through the API's sponsored fee-bump", async ({ page }) => {
  test.setTimeout(6 * 60_000);
  const { session, ops } = await closeWith(
    page,
    {
      scenarios: [
        { id: "data-entries", params: { count: 2 } },
        { id: "forgotten-signer", params: {} },
        { id: "fee-bump", params: {} },
      ],
    },
    "Sponsored fee",
    null
  );
  // The drain: the demo paid its spare XLM back to the market maker before the close.
  const payments = (ops as PaymentOperation[]).filter(
    (op) =>
      op.type === "payment" &&
      op.from === session.demoPublic &&
      op.to === session.accounts.mm &&
      op.asset_type === "native"
  );
  expect(payments.length).toBeGreaterThanOrEqual(1);

  const res = await fetch(
    `${HORIZON}/accounts/${session.demoPublic}/transactions?order=desc&limit=1`
  );
  expect(res.ok).toBe(true);
  const [close] = ((await res.json()) as { _embedded: { records: HorizonTransaction[] } })._embedded
    .records;
  // The merge's transaction was paid by the fee account, around an inner close of fee zero.
  expect(close?.source_account).toBe(session.demoPublic);
  expect(close?.fee_account).toBe(feeAccount());
  expect(close?.inner_transaction?.max_fee).toBe("0");
  expect(close?.inner_transaction?.hash).not.toBe(close?.hash);
});
