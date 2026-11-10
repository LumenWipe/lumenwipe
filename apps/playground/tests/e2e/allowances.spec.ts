import { expect, test } from "@playwright/test";
import { scValToNative, xdr } from "@stellar/stellar-sdk";
import { ALLOWANCE_SEED, XLM_SAC } from "../../lib/scenarios";
import { closeWith } from "./close-with";

// The allowances scenario end to end on testnet: the demo approves three spenders on XLM's asset
// contract, the first until the longest expiry the network allows, and before the close the page
// shows the API's allowance list and revokes every recorded allowance with the transaction the
// API builds, once both revoke checks accept it; the close then merges the account.

interface InvokeOperation {
  type: string;
  parameters?: { type: string; value: string }[];
}

/** The contract, function, spender and amount of an `approve`, as Horizon records it. */
function approveOf(op: InvokeOperation): {
  contract: string;
  fn: string;
  spender: string;
  amount: bigint;
} {
  const [contract, fn, , spender, amount] = (op.parameters ?? []).map(
    (p) => scValToNative(xdr.ScVal.fromXDR(p.value, "base64")) as unknown
  );
  return {
    contract: String(contract),
    fn: String(fn),
    spender: String(spender),
    amount: BigInt(String(amount)),
  };
}

test("every allowance the demo approved is revoked through the API before the merge", async ({
  page,
}) => {
  test.setTimeout(8 * 60_000);
  const { ops } = await closeWith(
    page,
    { scenarios: [{ id: "allowances", params: { spenders: 3 } }] },
    "Token allowances",
    null
  );
  const calls = (ops as InvokeOperation[])
    .filter((op) => op.type === "invoke_host_function")
    .map(approveOf);
  expect(calls).toHaveLength(6);
  for (const call of calls) expect([call.contract, call.fn]).toEqual([XLM_SAC, "approve"]);
  const [approves, revokes] = [calls.slice(0, 3), calls.slice(3)];
  expect(approves.map((c) => c.amount)).toEqual(
    ALLOWANCE_SEED.amountsXlm.map((xlm) => BigInt(xlm) * BigInt(10_000_000))
  );
  expect(new Set(approves.map((c) => c.spender)).size).toBe(3);
  // One revoke per spender, in the record's order, each to zero.
  expect(revokes.map((c) => [c.spender, c.amount])).toEqual(
    approves.map((c) => [c.spender, BigInt(0)])
  );
});
