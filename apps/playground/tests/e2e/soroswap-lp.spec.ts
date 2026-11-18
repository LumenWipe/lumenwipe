import { expect, test } from "./timed";
import { scValToNative, xdr } from "@stellar/stellar-sdk";
import { SOROSWAP, SOROSWAP_SEED } from "../../lib/scenarios";
import { closeWith, count } from "./close-with";
import { dexSellsUsdc } from "./testnet";

// The Soroswap liquidity scenario end to end on testnet: the demo buys Circle's test USDC on the
// DEX, pairs it with XLM in the real Soroswap pool through the router, and the close withdraws the
// position through the real API (the exit the playground's Soroban check and the shared verifier
// both pass) before it returns the USDC to its issuer and merges.

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

test("a Soroswap liquidity position is withdrawn through the API before the merge", async ({
  page,
}) => {
  test.setTimeout(8 * 60_000);
  // A testnet market outage, not a playground failure: reported as skipped, with the reason. The
  // app itself refuses the step before signing it (tests/unit/soroswap-seed.test.ts).
  test.skip(
    !(await dexSellsUsdc(SOROSWAP_SEED)),
    "The testnet DEX sells no Circle USDC within the ceiling"
  );

  const { ops } = await closeWith(
    page,
    { scenarios: [{ id: "soroswap-lp", params: {} }] },
    "Soroswap liquidity",
    null
  );
  const calls = (ops as InvokeOperation[])
    .filter((op) => op.type === "invoke_host_function")
    .map(callOf);
  // The seeding deposit, then the exit, both through the pinned router.
  expect(calls).toEqual([
    { contract: SOROSWAP.router, fn: "add_liquidity" },
    { contract: SOROSWAP.router, fn: "remove_liquidity" },
  ]);
  // The trustline opened for the purchase and removed by the close.
  expect(count(ops, "change_trust")).toBe(2);
});
