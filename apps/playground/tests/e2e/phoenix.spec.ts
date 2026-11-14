import { expect, test } from "./timed";
import { scValToNative, xdr } from "@stellar/stellar-sdk";
import { phoenixReads, phoenixSwapFits } from "../../lib/phoenix-pool";
import { networkStroops } from "../../lib/stroops";
import { PHOENIX, PHOENIX_SEED } from "../../lib/scenarios";
import { closeWith, count } from "./close-with";

// The Phoenix liquidity scenario end to end on testnet: the demo swaps a little XLM for LWPHX in
// the real Phoenix pool, pairs it back with XLM there, and in the bonded variant bonds half the
// shares in the pool's stake; the close leaves through the real API (the exits the playground's
// Soroban check and the shared verifier both pass): the unbond first when there is a stake, then
// the withdrawal, before the merge.

interface InvokeOperation {
  type: string;
  parameters?: { type: string; value: string }[];
}

/** The contract and function an invoke_host_function operation called, as Horizon records it. */
function callOf(op: InvokeOperation): { contract: string; fn: string } {
  const [contract, fn] = (op.parameters ?? []).map((p) =>
    String(scValToNative(xdr.ScVal.fromXDR(p.value, "base64")))
  );
  return { contract: contract ?? "", fn: fn ?? "" };
}

const run = async (page: Parameters<typeof closeWith>[0], variant: 0 | 1) => {
  test.setTimeout(8 * 60_000);
  // A pool too thin to sell the LWPHX, not a playground failure: reported as skipped, with the
  // reason. The app itself refuses the step before signing it (tests/unit/phoenix-seed.test.ts).
  const quote = await phoenixReads().swapQuote(networkStroops(PHOENIX_SEED.swapXlm));
  test.skip(!phoenixSwapFits(quote), "The testnet Phoenix pool cannot sell LWPHX within the gate");

  const { ops } = await closeWith(
    page,
    { scenarios: [{ id: "phoenix-lp", params: { variant } }] },
    "Phoenix liquidity",
    null
  );
  // No trustline is opened or removed: LWPHX is a Soroban token and XLM is native.
  expect(count(ops, "change_trust")).toBe(0);
  return (ops as InvokeOperation[]).filter((op) => op.type === "invoke_host_function").map(callOf);
};

test("a Phoenix liquidity position is withdrawn through the API before the merge", async ({
  page,
}) => {
  expect(await run(page, 0)).toEqual([
    { contract: PHOENIX.pool, fn: "swap" },
    { contract: PHOENIX.pool, fn: "provide_liquidity" },
    { contract: PHOENIX.pool, fn: "withdraw_liquidity" },
  ]);
});

test("a bonded Phoenix position is unbonded, then withdrawn, before the merge", async ({
  page,
}) => {
  expect(await run(page, 1)).toEqual([
    { contract: PHOENIX.pool, fn: "swap" },
    { contract: PHOENIX.pool, fn: "provide_liquidity" },
    { contract: PHOENIX.stake, fn: "bond" },
    { contract: PHOENIX.stake, fn: "unbond" },
    { contract: PHOENIX.pool, fn: "withdraw_liquidity" },
  ]);
});
