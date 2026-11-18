import { expect, test } from "./timed";
import { rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { SOROBAN_RPC_TESTNET_URL } from "../../lib/horizon-submit";
import { phoenixReads } from "../../lib/phoenix-pool";
import { PLAYGROUND_TOKEN, PLAYGROUND_TOKEN_SEED } from "../../lib/scenarios";
import { networkStroops } from "../../lib/stroops";
import { playgroundTokenDeployed } from "../../lib/token-deploy";
import { closeWith } from "./close-with";

// The Soroban token scenario end to end on testnet: the playground token's admin mints it to the
// demo, and the close either sends it back to the admin through the real API (a transfer both the
// playground's Soroban check and the shared verifier pass) or leaves it with the closed address,
// which is then read from the ledger. The token is the operator's (scripts/deploy-token.ts), and
// the server signs its mint with the admin key from the nightly's environment.

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

const run = async (page: Parameters<typeof closeWith>[0], disposition: 0 | 1) => {
  test.setTimeout(6 * 60_000);
  // Between a merge and the operator's one-off deployment the token is not there yet, and the
  // playground reports the scenario unavailable: skipped, with the reason.
  const deployed = await playgroundTokenDeployed(new rpc.Server(SOROBAN_RPC_TESTNET_URL));
  test.skip(!deployed, "The playground token is not on testnet yet: run `bun run token:deploy`");

  const { session, ops } = await closeWith(
    page,
    { scenarios: [{ id: "soroban-token", params: { disposition } }] },
    "Soroban token",
    null
  );
  // The token needs no trustline, so none is opened or removed.
  expect(ops.some((op) => op.type === "change_trust")).toBe(false);
  const transfers = (ops as InvokeOperation[])
    .filter((op) => op.type === "invoke_host_function")
    .map(callOf)
    .filter((call) => call.contract === PLAYGROUND_TOKEN.contract && call.fn === "transfer");
  const left = await phoenixReads().balance(PLAYGROUND_TOKEN.contract, session.demoPublic);
  return { transfers: transfers.length, left };
};

test("a Soroban token is sent back to the playground through the API before the merge", async ({
  page,
}) => {
  expect(await run(page, 0)).toEqual({ transfers: 1, left: BigInt(0) });
});

test("a Soroban token left as residue stays with the closed address", async ({ page }) => {
  expect(await run(page, 1)).toEqual({
    transfers: 0,
    left: networkStroops(PLAYGROUND_TOKEN_SEED.amount),
  });
});
