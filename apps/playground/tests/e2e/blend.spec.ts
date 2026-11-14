import { expect, test } from "./timed";
import { scValToNative, xdr } from "@stellar/stellar-sdk";
import { blendBorrowFits, readBlendReserve } from "../../lib/blend-utilization";
import { networkStroops } from "../../lib/stroops";
import { BLEND, BLEND_REQUEST, BLEND_SEED } from "../../lib/scenarios";
import { closeWith, count } from "./close-with";

// The Blend lending scenario end to end on testnet: the demo supplies XLM to the real Blend pool
// as collateral, borrowing XLM against it in the second variant, and the close leaves the pool
// through the real API (the exits the playground's Soroban check and the shared verifier both
// pass): a repay first when there is a debt, then the collateral's withdrawal, before the merge.

interface InvokeOperation {
  type: string;
  parameters?: { type: string; value: string }[];
}

/** The contract, function and request types of a Blend `submit`, as Horizon records it. */
function callOf(op: InvokeOperation): { contract: string; fn: string; types: number[] } {
  const [contract, fn, , , , requests] = (op.parameters ?? []).map(
    (p) => scValToNative(xdr.ScVal.fromXDR(p.value, "base64")) as unknown
  );
  const types = Array.isArray(requests)
    ? requests.map((r) => Number((r as { request_type: unknown }).request_type))
    : [];
  return { contract: String(contract), fn: String(fn), types };
}

const run = async (page: Parameters<typeof closeWith>[0], variant: 0 | 1) => {
  const { ops } = await closeWith(
    page,
    { scenarios: [{ id: "blend-supply", params: { variant } }] },
    "Blend lending",
    null
  );
  // No trustline is opened or removed: XLM is the only asset.
  expect(count(ops, "change_trust")).toBe(0);
  return (ops as InvokeOperation[]).filter((op) => op.type === "invoke_host_function").map(callOf);
};

test("a Blend supply is withdrawn through the API before the merge", async ({ page }) => {
  test.setTimeout(8 * 60_000);
  // Supplying needs nothing from the pool, so this test never skips.
  const calls = await run(page, 0);
  expect(calls).toEqual([
    { contract: BLEND.pool, fn: "submit", types: [BLEND_REQUEST.supplyCollateral] },
    { contract: BLEND.pool, fn: "submit", types: [BLEND_REQUEST.withdrawCollateral] },
  ]);
});

test("a Blend borrow is repaid, then the collateral withdrawn, before the merge", async ({
  page,
}) => {
  test.setTimeout(8 * 60_000);
  // A testnet pool lent to its cap, not a playground failure: reported as skipped, with the reason.
  // The app itself refuses the step before signing it (tests/unit/blend-seed.test.ts).
  const fits = blendBorrowFits(
    await readBlendReserve(),
    networkStroops(BLEND_SEED.supplyXlm),
    networkStroops(BLEND_SEED.borrowXlm)
  );
  test.skip(!fits, "The testnet Blend pool's XLM utilization is at or over its cap");

  const calls = await run(page, 1);
  expect(calls).toEqual([
    {
      contract: BLEND.pool,
      fn: "submit",
      types: [BLEND_REQUEST.supplyCollateral, BLEND_REQUEST.borrow],
    },
    { contract: BLEND.pool, fn: "submit", types: [BLEND_REQUEST.repay] },
    { contract: BLEND.pool, fn: "submit", types: [BLEND_REQUEST.withdrawCollateral] },
  ]);
});
