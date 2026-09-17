import { expect, test } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import type { AquariusLpPosition } from "@lumenwipe/types";
import { aquariusExitAdapter, runExitAdapter } from "@/lib/defi-exits";
import { readAquariusPool } from "@/lib/defi-positions/enrich/aquarius";
import { servedContractRegistry } from "@/lib/contract-registry";
import { getRpcServer } from "@/lib/stellar/rpc";

// Live testnet, opt-in like the other integration tests (`bun run test:integration`). Runs the real
// runner over the registry's representative constant-product pool with an account that never held
// shares. Three claims: the pool's live code resolves in the shipped registry (`resolution`
// comes back `known`), the adapter refuses rather than calling the position gone
// (`aquarius_shares_unreadable`, which it can only reach by recognising a share-based pool), and
// the pool reader returns null for an account with no share entry instead of inventing a zero. The full withdraw path runs live in
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
    // Null, not a zero-share view: `readAquariusPool` refuses to report "0 shares" for an
    // account whose balance entry is absent, because that would contradict the exit, which
    // treats an absent entry as unreadable rather than empty. This test used to assert the
    // opposite - a view with `shares: 0n` - for an account that by construction has no entry,
    // so it could never have passed. Nothing noticed for two weeks because the integration
    // suite did not run anywhere; it does now.
    expect(view).toBeNull();
  },
  30_000
);
