// Must stay the first import, exactly as in src/main.ts - see sponsorship.integration.test.ts
// for the full rationale (config/networks.ts reads process.env at import time).
import "@/env";
import { test, expect } from "bun:test";
import { Horizon, Keypair, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import type { FxdaoCdpPosition } from "@lumenwipe/types";
import { EXIT_POSITION_GONE, fxdaoExitAdapter, runExitAdapter } from "@/lib/defi-exits";
import { getRpcServer } from "@/lib/stellar/rpc";
import { submitAndWait } from "@/lib/stellar/submit";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import {
  FXDAO_CURRENCY_CONTRACT,
  FXDAO_DEBT_UNITS,
  FXDAO_DENOMINATION,
  FXDAO_VAULT,
  feedFxdaoOraclePrice,
  openFxdaoVault,
} from "./fixtures/fxdao-vault-setup";

// This is the "own fixture" tier of the integration suite (issue #286): it funds a fresh testnet
// account, opens a real vault on the project's own reference FxDAO deployment, then exits it
// through the real, unmodified production adapter and submit path - never a pre-seeded account,
// which a prior run (or someone else entirely) could have already closed or drained. Gated behind
// LUMENWIPE_INTEGRATION_FUNDED like sponsorship.integration.test.ts and
// multisig-close.integration.test.ts, because it funds real accounts and submits real
// transactions rather than only reading.
const RUN_INTEGRATION =
  !!process.env.LUMENWIPE_RUN_INTEGRATION && !!process.env.LUMENWIPE_INTEGRATION_FUNDED;

const FRIENDBOT = "https://friendbot.stellar.org";
const HORIZON_URL = "https://horizon-testnet.stellar.org";

async function fund(publicKey: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT}?addr=${publicKey}`);
  if (!res.ok) throw new Error(`friendbot funding failed for ${publicKey}: ${res.status}`);
}

test.skipIf(!RUN_INTEGRATION)(
  "a self-opened FxDAO vault closes end to end through the real adapter",
  async () => {
    const oracleAdminSecret = process.env.FXDAO_TESTNET_ORACLE_ADMIN_SECRET;
    if (!oracleAdminSecret) {
      throw new Error("FXDAO_TESTNET_ORACLE_ADMIN_SECRET is required for this test");
    }
    const oracleAdmin = Keypair.fromSecret(oracleAdminSecret);
    const account = Keypair.random();
    await fund(account.publicKey());

    await feedFxdaoOraclePrice(oracleAdmin);
    await openFxdaoVault(account);

    const horizon = new Horizon.Server(HORIZON_URL);
    const rpc = getRpcServer("testnet");
    const position: FxdaoCdpPosition = {
      protocol: "fxdao",
      positionType: "cdp",
      contractAddress: FXDAO_VAULT,
      denomination: FXDAO_DENOMINATION,
      collateralAmount: "0",
      debtAmount: "0",
      usdValue: null,
    };
    const adapter = fxdaoExitAdapter();

    // A single full pay_debt clears the vault (fxdao.ts's own module doc explains why there is
    // never a separate withdrawal step), so this loop runs once before the second call reports
    // the position gone - but it is written to repeat, matching how the real close loop drives
    // any adapter to completion rather than assuming a fixed step count.
    for (let round = 0; round < 3; round++) {
      const live = await horizon.loadAccount(account.publicKey());
      const result = await runExitAdapter(
        adapter,
        position,
        {
          network: "testnet",
          account: account.publicKey(),
          sequence: live.sequenceNumber(),
          tokenBalances: { [FXDAO_CURRENCY_CONTRACT]: FXDAO_DEBT_UNITS.toString() },
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
    throw new Error("fxdao vault did not close within 3 rounds");
  },
  120_000
);
