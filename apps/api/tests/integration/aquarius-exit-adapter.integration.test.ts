import { expect, test } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import type { AquariusLpPosition } from "@lumenwipe/types";
import { aquariusExitAdapter, runExitAdapter } from "@/lib/defi-exits";
import { readAquariusPool } from "@/lib/defi-positions/enrich/aquarius";
import { servedContractRegistry } from "@/lib/contract-registry";
import { getRpcServer } from "@/lib/stellar/rpc";

// Live testnet, opt-in like the other integration tests (`bun run test:integration`). Runs the real
// runner over the registry's representative constant-product pool with an account that never held
// shares: the pool's live code must resolve in the shipped registry, the pool must read as a
// share-based pool, and - since the account has no share entry - the adapter must refuse rather
// than call the position gone. The full withdraw path runs live in
// apps/web/tests/e2e/aquarius-exit.spec.ts.
const RUN_INTEGRATION = !!process.env.LUMENWIPE_RUN_INTEGRATION;

test.skipIf(!RUN_INTEGRATION)(
  "the registry's Aquarius testnet pool resolves, reads as a pool, and an account with no share entry is refused",
  async () => {
    const pool = servedContractRegistry().entries.find(
      (e) =>
        e.network === "testnet" &&
        e.protocol === "aquarius" &&
        e.kind === "pool" &&
        e.version === "constant_product"
    );
    expect(pool).toBeDefined();
    const account = Keypair.random().publicKey();
    const position: AquariusLpPosition = {
      protocol: "aquarius",
      positionType: "lp",
      contractAddress: pool!.address,
      shareAmount: "1",
      usdValue: null,
    };
    const result = await runExitAdapter(
      aquariusExitAdapter(),
      position,
      {
        network: "testnet",
        account,
        sequence: "1",
        tokenBalances: {},
        now: new Date(),
        slippageBps: 50,
      },
      { rpc: getRpcServer("testnet") }
    );
    expect(result.resolution?.status).toBe("known");
    expect(result.blockers.map((b) => b.code)).toEqual(["aquarius_shares_unreadable"]);

    const view = await readAquariusPool(
      getRpcServer("testnet"),
      pool!.address,
      account,
      "constant_product"
    );
    expect(view).not.toBeNull();
    expect(view!.tokens).toHaveLength(2);
    expect(view!.reserves).toHaveLength(2);
    expect(view!.totalShares).toBeGreaterThan(0n);
    expect(view!.shares).toBe(0n);
  },
  30_000
);
