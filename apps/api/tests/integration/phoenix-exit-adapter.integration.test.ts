// Must stay the first import, exactly as in src/main.ts - see sponsorship.integration.test.ts
// for the full rationale (config/networks.ts reads process.env at import time).
import "@/env";
import { test, expect } from "bun:test";
import { Horizon, Keypair, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import type { PhoenixLpPosition } from "@lumenwipe/types";
import { EXIT_POSITION_GONE, phoenixExitAdapter, runExitAdapter } from "@/lib/defi-exits";
import { getRpcServer } from "@/lib/stellar/rpc";
import { submitAndWait } from "@/lib/stellar/submit";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import {
  PHOENIX_POOL,
  bondPhoenixShares,
  mintPhoenixTokenA,
  providePhoenixLiquidity,
} from "./fixtures/phoenix-pool-setup";

// This is the "own fixture" tier of the integration suite (issue #286): it funds a fresh testnet
// account, provides real liquidity into the project's own reference Phoenix pool, stakes part of
// it, then exits both the stake and the LP position through the real, unmodified production
// adapter and submit path - never a pre-seeded account. Gated behind LUMENWIPE_INTEGRATION_FUNDED
// like sponsorship.integration.test.ts and multisig-close.integration.test.ts.
const RUN_INTEGRATION =
  !!process.env.LUMENWIPE_RUN_INTEGRATION && !!process.env.LUMENWIPE_INTEGRATION_FUNDED;

const FRIENDBOT = "https://friendbot.stellar.org";
const HORIZON_URL = "https://horizon-testnet.stellar.org";
const DEPOSIT = 100_000_000n; // 10 units of each side, 7-decimal base units

async function fund(publicKey: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT}?addr=${publicKey}`);
  if (!res.ok) throw new Error(`friendbot funding failed for ${publicKey}: ${res.status}`);
}

test.skipIf(!RUN_INTEGRATION)(
  "a self-provided, partially staked Phoenix LP position closes end to end through the real adapter",
  async () => {
    const tokenAdminSecret = process.env.PHOENIX_TESTNET_TOKEN_ADMIN_SECRET;
    if (!tokenAdminSecret) {
      throw new Error("PHOENIX_TESTNET_TOKEN_ADMIN_SECRET is required for this test");
    }
    const tokenAdmin = Keypair.fromSecret(tokenAdminSecret);
    const account = Keypair.random();
    await fund(account.publicKey());

    await mintPhoenixTokenA(tokenAdmin, account.publicKey(), DEPOSIT);
    await providePhoenixLiquidity(account, DEPOSIT, DEPOSIT);
    // Stake roughly half the minted shares (99,999,000 after the pool's fixed 1,000-share
    // minimum-liquidity lock), so the close loop has to walk both the unbond and the withdraw
    // leg - not just whichever one a single-round test would happen to exercise.
    await bondPhoenixShares(account, 40_000_000n);

    const horizon = new Horizon.Server(HORIZON_URL);
    const rpc = getRpcServer("testnet");
    const position: PhoenixLpPosition = {
      protocol: "phoenix",
      positionType: "lp",
      contractAddress: PHOENIX_POOL,
      shareAmount: "0",
      usdValue: null,
    };
    const adapter = phoenixExitAdapter();

    // Up to 2 real rounds: unbond first (phoenix.ts's plan() always drains every stake before any
    // withdrawal), then withdraw_liquidity for the combined balance, then the position is gone.
    for (let round = 0; round < 4; round++) {
      const live = await horizon.loadAccount(account.publicKey());
      const result = await runExitAdapter(
        adapter,
        position,
        {
          network: "testnet",
          account: account.publicKey(),
          sequence: live.sequenceNumber(),
          tokenBalances: {},
          now: new Date(),
          slippageBps: 50,
        },
        { rpc }
      );

      if (result.blockers.some((b) => b.code === EXIT_POSITION_GONE)) {
        return;
      }
      expect(result.blockers).toEqual([]);
      if (!result.next) throw new Error("expected a built step");

      const tx = TransactionBuilder.fromXDR(
        result.next.simulation.txXdr,
        NETWORK_PASSPHRASES.testnet
      );
      if (!(tx instanceof Transaction))
        throw new Error("expected a plain transaction, not a fee bump");
      tx.sign(account);
      await submitAndWait(tx.toXDR(), "testnet");
    }
    throw new Error("phoenix position did not close within 4 rounds");
  },
  120_000
);
