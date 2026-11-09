import { expect, test } from "bun:test";
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  nativeToScVal,
  Networks,
  rpc,
  scValToNative,
  TransactionBuilder,
  type xdr,
} from "@stellar/stellar-sdk";
import type { CloseTransaction } from "@lumenwipe/sdk";
import { loadHorizonAccount, SOROBAN_RPC_TESTNET_URL } from "@/lib/horizon-submit";
import { executeMessStep, type MessContext } from "@/lib/mess-builders";
import { resolvePlan, SOROSWAP } from "@/lib/scenarios";
import { expectationFromSession, verifyDemolishTransaction } from "@/lib/verify";

// Manual only: `bun run --filter '@lumenwipe/playground' test:integration`. Needs real testnet
// Friendbot, Horizon and Soroban RPC access; gated inside the test like the other integration
// tests, so a bare `bun test` never reaches the network.
//
// A fresh Friendbot account runs the Soroswap scenario's three seeding steps through the real
// executors, then builds the exit the API's adapter builds (apps/api/src/lib/defi-exits/
// soroswap.ts) from the pair's live reserves, has the RPC simulate and assemble it, and holds the
// assembled transaction to both of the playground's checks before it signs and sends it: the
// authorization tree checked is the one testnet really returns, not a hand-built one.
const RUN_INTEGRATION = !!process.env.LUMENWIPE_RUN_INTEGRATION;

const SLIPPAGE_BPS = BigInt(50);

test.skipIf(!RUN_INTEGRATION)(
  "a seeded Soroswap position is exited by a call both checks accept, and it confirms",
  async () => {
    const demo = Keypair.random();
    const funded = await fetch(
      `https://friendbot.stellar.org/?addr=${encodeURIComponent(demo.publicKey())}`
    );
    expect(funded.ok).toBe(true);

    const selection = { scenarios: [{ id: "soroswap-lp" as const, params: {} }] };
    const ctx: MessContext = {
      demo,
      ephemeralIssuers: new Map(),
      persistentIssuer: Keypair.random(),
      mmPublic: Keypair.random().publicKey(),
      transferRecipient: null,
      helpers: new Map(),
      recordSigner: async () => {},
      recordClaimableBalances: async () => {},
    };
    for (const step of resolvePlan(selection).steps.filter((s) => s.id !== "SETUP")) {
      console.log(`${step.id}: ${await executeMessStep(step, ctx)}`);
    }

    const server = new rpc.Server(SOROBAN_RPC_TESTNET_URL);
    const read = async (contract: string, fn: string, ...args: xdr.ScVal[]): Promise<unknown> => {
      const tx = new TransactionBuilder(new Account(demo.publicKey(), "0"), {
        fee: BASE_FEE,
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(new Contract(contract).call(fn, ...args))
        .setTimeout(30)
        .build();
      const sim = await server.simulateTransaction(tx);
      if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) throw new Error(`${fn} failed`);
      return scValToNative(sim.result.retval);
    };
    const shares = (await read(
      SOROSWAP.pair,
      "balance",
      new Address(demo.publicKey()).toScVal()
    )) as bigint;
    const [reserve0, reserve1] = (await read(SOROSWAP.pair, "get_reserves")) as bigint[];
    const supply = (await read(SOROSWAP.pair, "total_supply")) as bigint;
    expect(shares > BigInt(0)).toBe(true);
    const floor = (reserve: bigint): bigint =>
      (((shares * reserve!) / supply) * (BigInt(10_000) - SLIPPAGE_BPS)) / BigInt(10_000);

    const i128 = (v: bigint): xdr.ScVal => nativeToScVal(v, { type: "i128" });
    const live = await loadHorizonAccount(demo.publicKey());
    const exit = new TransactionBuilder(new Account(demo.publicKey(), live.sequenceNumber()), {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        new Contract(SOROSWAP.router).call(
          "remove_liquidity",
          new Address(SOROSWAP.tokens[0]).toScVal(),
          new Address(SOROSWAP.tokens[1]).toScVal(),
          i128(shares),
          i128(floor(reserve0!)),
          i128(floor(reserve1!)),
          new Address(demo.publicKey()).toScVal(),
          nativeToScVal(BigInt(Math.floor(Date.now() / 1000) + 300), { type: "u64" })
        )
      )
      .setTimeout(120)
      .build();
    const sim = await server.simulateTransaction(exit);
    if (!rpc.Api.isSimulationSuccess(sim)) throw new Error("the exit did not simulate");
    const assembled = rpc.assembleTransaction(exit, sim).build();

    const expected = expectationFromSession(
      {
        demoPublic: demo.publicKey(),
        ephemeralIssuers: [],
        recordedSigners: [],
        selection,
        transferRecipient: null,
        helperAccounts: [],
        claimableBalances: [],
      },
      Keypair.random().publicKey(),
      ctx.persistentIssuer.publicKey()
    );
    const close: CloseTransaction = {
      id: "exit",
      order: 0,
      dependsOn: [],
      xdr: assembled.toXDR(),
      networkPassphrase: Networks.TESTNET,
      sourceSequence: live.sequenceNumber(),
      validUntilLedger: 0,
      covers: [],
      intent: {
        summary: "Soroswap exit",
        source: demo.publicKey(),
        fee: assembled.fee,
        memo: null,
        memoType: null,
        guarantees: { mergeDestination: null, paymentsOnlyTo: [], minXlmFromConversions: null },
        operations: [],
      },
    };
    expect(() => verifyDemolishTransaction(close, expected)).not.toThrow();

    assembled.sign(demo);
    const sent = await server.sendTransaction(assembled);
    expect(sent.status).toBe("PENDING");
    const done = await server.pollTransaction(sent.hash, { attempts: 30 });
    console.log(`exit ${sent.hash}: ${done.status}`);
    expect(done.status).toBe(rpc.Api.GetTransactionStatus.SUCCESS);
    expect(await read(SOROSWAP.pair, "balance", new Address(demo.publicKey()).toScVal())).toBe(
      BigInt(0)
    );
  },
  240_000
);
