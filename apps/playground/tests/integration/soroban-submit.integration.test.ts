import { expect, test } from "bun:test";
import { Address, Asset, Keypair, Networks, nativeToScVal, rpc } from "@stellar/stellar-sdk";
import { SOROBAN_RPC_TESTNET_URL } from "@/lib/horizon-submit";
import { seedContractCall } from "@/lib/soroban-seed";

// Manual only: `bun run --filter '@lumenwipe/playground' test:integration`. Needs real testnet
// Friendbot, Horizon and Soroban RPC access; gated inside the test like full-cycle.integration,
// so a bare `bun test` never reaches the network.
//
// A fresh Friendbot account calls the native asset contract's `approve` through the same path
// the seeding scenarios use: sequence from Horizon, simulation, the checks on what the simulation
// returned, signing with the account's own key, send and poll until it confirms.
const RUN_INTEGRATION = !!process.env.LUMENWIPE_RUN_INTEGRATION;

test.skipIf(!RUN_INTEGRATION)(
  "a Soroban contract call confirms on testnet through submitSoroban",
  async () => {
    const source = Keypair.random();
    const funded = await fetch(
      `https://friendbot.stellar.org/?addr=${encodeURIComponent(source.publicKey())}`
    );
    expect(funded.ok).toBe(true);

    const server = new rpc.Server(SOROBAN_RPC_TESTNET_URL);
    const { sequence } = await server.getLatestLedger();
    const { txHash } = await seedContractCall(source, {
      contract: Asset.native().contractId(Networks.TESTNET),
      function: "approve",
      args: [
        new Address(source.publicKey()).toScVal(),
        new Address(Keypair.random().publicKey()).toScVal(),
        nativeToScVal(BigInt(1), { type: "i128" }),
        nativeToScVal(sequence + 1000, { type: "u32" }),
      ],
    });
    console.log(`confirmed ${txHash}`);
    expect(txHash).toMatch(/^[0-9a-f]{64}$/);
    const confirmed = await server.getTransaction(txHash);
    expect(confirmed.status).toBe(rpc.Api.GetTransactionStatus.SUCCESS);
  },
  120_000
);
