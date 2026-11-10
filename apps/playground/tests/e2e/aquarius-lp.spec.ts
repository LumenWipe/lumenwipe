import { expect, test } from "@playwright/test";
import { scValToNative, xdr } from "@stellar/stellar-sdk";
import { AQUARIUS, AQUARIUS_SEED, PINNED_ASSETS } from "../../lib/scenarios";
import { closeWith, count } from "./close-with";
import { HORIZON } from "./testnet";

// The Aquarius liquidity scenario end to end on testnet: the demo buys Circle's test USDC on the
// DEX, pairs it with XLM in the real Aquarius pool through the router, and the close withdraws the
// position from the pool through the real API (the exit the playground's Soroban check and the
// shared verifier both pass) before it returns the USDC to its issuer and merges.

const CIRCLE = PINNED_ASSETS["circle-usdc"];

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

/** Whether the testnet DEX sells the scenario's USDC within its ceiling right now. */
async function dexSellsUsdc(): Promise<boolean> {
  const query = new URLSearchParams({
    source_assets: "native",
    destination_asset_type: "credit_alphanum4",
    destination_asset_code: CIRCLE.code,
    destination_asset_issuer: CIRCLE.issuer,
    destination_amount: AQUARIUS_SEED.usdc,
  });
  const res = await fetch(`${HORIZON}/paths/strict-receive?${query.toString()}`);
  if (!res.ok) return false;
  const body = (await res.json()) as { _embedded: { records: { source_amount: string }[] } };
  return body._embedded.records.some(
    (r) => Number(r.source_amount) <= Number(AQUARIUS_SEED.buyMaxXlm)
  );
}

test("an Aquarius liquidity position is withdrawn through the API before the merge", async ({
  page,
}) => {
  test.setTimeout(8 * 60_000);
  // A testnet market outage, not a playground failure: reported as skipped, with the reason. The
  // app itself refuses the step before signing it (tests/unit/soroswap-seed.test.ts).
  test.skip(!(await dexSellsUsdc()), "The testnet DEX sells no Circle USDC within the ceiling");

  const { ops } = await closeWith(
    page,
    { scenarios: [{ id: "aquarius-lp", params: {} }] },
    "Aquarius liquidity",
    null
  );
  const calls = (ops as InvokeOperation[])
    .filter((op) => op.type === "invoke_host_function")
    .map(callOf);
  // The seeding deposit through the pinned router, then the exit on the pinned pool itself.
  expect(calls).toEqual([
    { contract: AQUARIUS.router, fn: "deposit" },
    { contract: AQUARIUS.pool, fn: "withdraw" },
  ]);
  // The trustline opened for the purchase and removed by the close.
  expect(count(ops, "change_trust")).toBe(2);
});
