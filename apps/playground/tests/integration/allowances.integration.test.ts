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
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { readLedgerTtl, revokeRecordedAllowance, type AllowanceApi } from "@/lib/allowances";
import { loadSignerState, SOROBAN_RPC_TESTNET_URL } from "@/lib/horizon-submit";
import { executeMessStep, type MessContext } from "@/lib/mess-builders";
import type { RecordedAllowance } from "@/lib/session-store";
import { ALLOWANCE_SEED, resolvePlan, XLM_SAC } from "@/lib/scenarios";

// Manual only: `bun run --filter '@lumenwipe/playground' test:integration`. Needs real testnet
// Friendbot, Horizon and Soroban RPC access; gated inside the test like the other integration
// tests, so a bare `bun test` never reaches the network.
//
// A fresh Friendbot account runs the allowances scenario's three approve steps through the real
// executor, which reads the ledger and the network's maximum entry TTL live, so the first spender's
// allowance lives as long as the network allows. Each allowance is then revoked through
// `revokeRecordedAllowance` with the transaction built exactly as the API builds it
// (apps/api/src/lib/stellar/revoke-allowance.ts: `approve(owner, spender, 0, 0)`, base fee, 300
// seconds, simulated and assembled by the RPC), so both revoke checks run against the
// authorization testnet really returns before the demo key signs.
const RUN_INTEGRATION = !!process.env.LUMENWIPE_RUN_INTEGRATION;

const server = new rpc.Server(SOROBAN_RPC_TESTNET_URL);

async function allowanceOf(owner: string, spender: string): Promise<bigint> {
  const tx = new TransactionBuilder(new Account(owner, "0"), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      new Contract(XLM_SAC).call(
        "allowance",
        new Address(owner).toScVal(),
        new Address(spender).toScVal()
      )
    )
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) throw new Error("allowance read failed");
  return scValToNative(sim.result.retval) as bigint;
}

/** The revoke as the API builds it, and its submit, against testnet itself. */
const apiLikeRevoke: AllowanceApi = {
  getAllowances: async () => ({ allowances: [] }),
  revokeAllowance: async ({ owner, token, spender }) => {
    const live = await server.getAccount(owner);
    const raw = new TransactionBuilder(new Account(owner, live.sequenceNumber()), {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        new Contract(token).call(
          "approve",
          new Address(owner).toScVal(),
          new Address(spender).toScVal(),
          nativeToScVal(BigInt(0), { type: "i128" }),
          nativeToScVal(0, { type: "u32" })
        )
      )
      .setTimeout(300)
      .build();
    const sim = await server.simulateTransaction(raw);
    if (!rpc.Api.isSimulationSuccess(sim)) throw new Error("revoke did not simulate");
    return { transaction: rpc.assembleTransaction(raw, sim).build().toXDR() };
  },
  submit: async (signedXdr) => {
    const tx = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET) as Transaction;
    const sent = await server.sendTransaction(tx);
    if (sent.status !== "PENDING") throw new Error(`revoke not accepted: ${sent.status}`);
    const done = await server.pollTransaction(sent.hash, { attempts: 30 });
    if (done.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error("revoke failed");
    return { hash: sent.hash };
  },
};

test.skipIf(!RUN_INTEGRATION)(
  "three seeded allowances, the first at the farthest expiry, are each revoked past both checks",
  async () => {
    const demo = Keypair.random();
    const funded = await fetch(
      `https://friendbot.stellar.org/?addr=${encodeURIComponent(demo.publicKey())}`
    );
    expect(funded.ok).toBe(true);

    const recorded: RecordedAllowance[] = [];
    const ctx: MessContext = {
      demo,
      ephemeralIssuers: new Map(),
      persistentIssuer: Keypair.random(),
      mmPublic: Keypair.random().publicKey(),
      transferRecipient: null,
      helpers: new Map(),
      recordSigner: async () => {},
      recordClaimableBalances: async () => {},
      allowances: recorded,
      recordAllowance: async (index, allowance) => {
        recorded[index - 1] = allowance;
      },
    };
    const ttl = await readLedgerTtl();
    console.log(`latest ledger ${ttl.latestLedger}, max entry TTL ${ttl.maxEntryTtl}`);
    const selection = { scenarios: [{ id: "allowances" as const, params: { spenders: 3 } }] };
    for (const step of resolvePlan(selection).steps.filter((s) => s.id !== "SETUP")) {
      console.log(`${step.id}: ${await executeMessStep(step, ctx)}`);
    }
    expect(recorded).toHaveLength(3);
    // The far expiry is within one maximum TTL of the ledger read before it was sent.
    expect(recorded[0]!.liveUntilLedger).toBeGreaterThanOrEqual(
      ttl.latestLedger + ttl.maxEntryTtl - 1
    );
    for (const [i, allowance] of recorded.entries()) {
      const xlm = BigInt(Number(ALLOWANCE_SEED.amountsXlm[i]) * 10_000_000);
      expect(await allowanceOf(demo.publicKey(), allowance.spender)).toBe(xlm);
    }

    for (const allowance of recorded) {
      const hash = await revokeRecordedAllowance({
        demo,
        signingKeys: [],
        recorded,
        allowance,
        api: apiLikeRevoke,
        signerState: loadSignerState,
      });
      console.log(`revoke ${allowance.spender}: ${hash}`);
      expect(await allowanceOf(demo.publicKey(), allowance.spender)).toBe(BigInt(0));
    }
  },
  300_000
);
