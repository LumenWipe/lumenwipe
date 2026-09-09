import { expect, test } from "bun:test";
import { Keypair } from "@stellar/stellar-sdk";
import type { SoroswapLpPosition } from "@lumenwipe/types";
import { runExitAdapter, soroswapExitAdapter } from "@/lib/defi-exits";
import { readSoroswapPair } from "@/lib/defi-positions/enrich/soroswap";
import { servedContractRegistry } from "@/lib/contract-registry";
import { getRpcServer } from "@/lib/stellar/rpc";

// Live testnet, opt-in like the other integration tests (`bun run test:integration`). Runs the
// real runner over the registry's representative pair with an account that never held shares:
// the pair's and the router's live code must resolve in the shipped registry, the pair must read
// as a pair, and - since the account has no share entry at all - the adapter must refuse rather
// than call the position gone. No transaction is sent. The full withdraw path runs live in
// apps/web/tests/e2e/soroswap-exit.spec.ts.
const RUN_INTEGRATION = !!process.env.LUMENWIPE_RUN_INTEGRATION;

test.skipIf(!RUN_INTEGRATION)(
  "the registry's Soroswap testnet pair and router resolve, and an account with no share entry is refused",
  async () => {
    const pair = servedContractRegistry().entries.find(
      (e) => e.network === "testnet" && e.protocol === "soroswap" && e.kind === "pair"
    );
    expect(pair).toBeDefined();
    const account = Keypair.random().publicKey();
    const position: SoroswapLpPosition = {
      protocol: "soroswap",
      positionType: "lp",
      contractAddress: pair!.address,
      shareAmount: "1",
      usdValue: null,
    };
    const result = await runExitAdapter(
      soroswapExitAdapter(),
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
    expect(result.blockers.map((b) => b.code)).toEqual(["soroswap_shares_unreadable"]);

    const view = await readSoroswapPair(getRpcServer("testnet"), pair!.address, account);
    expect(view).not.toBeNull();
    expect(view!.name).toMatch(/Soroswap LP Token$/);
    expect(view!.totalSupply).toBeGreaterThan(0n);
    expect(view!.shares).toBe(0n);
  },
  30_000
);
