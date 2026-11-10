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
  xdr,
} from "@stellar/stellar-sdk";
import type { CloseTransaction } from "@lumenwipe/sdk";
import { blendBorrowFits, readBlendReserve } from "@/lib/blend-utilization";
import { loadHorizonAccount, SOROBAN_RPC_TESTNET_URL } from "@/lib/horizon-submit";
import { executeMessStep, type MessContext } from "@/lib/mess-builders";
import { networkStroops } from "@/lib/stroops";
import { BLEND, BLEND_REQUEST, BLEND_SEED, resolvePlan } from "@/lib/scenarios";
import { expectationFromSession, verifyDemolishTransaction } from "@/lib/verify";

// Manual only: `bun run --filter '@lumenwipe/playground' test:integration`. Needs real testnet
// Friendbot, Horizon and Soroban RPC access; gated inside the test like the other integration
// tests, so a bare `bun test` never reaches the network.
//
// A fresh Friendbot account runs the Blend scenario's seeding step (one `submit` to the pinned
// pool) through the real executor, then builds the exit the API's adapter builds
// (apps/api/src/lib/defi-exits/blend.ts) from the account's live positions: a repay first when
// there is a debt, then the collateral's withdrawal, one `submit` each, every amount over-asked by
// the adapter's accrual margin. Each is simulated and assembled by the RPC and held to both of the
// playground's checks before it is signed and sent, so the authorization tree checked is the one
// testnet really returns, not a hand-built one.
const RUN_INTEGRATION = !!process.env.LUMENWIPE_RUN_INTEGRATION;

const RATE_SCALE = BigInt(10) ** BigInt(12);
/** The adapter's margin over a position's balance (`BLEND_ACCRUAL_BUFFER_BPS`), rounded up. */
const withAccrualMargin = (amount: bigint): bigint =>
  (amount * BigInt(10_010) + BigInt(9_999)) / BigInt(10_000);

const server = new rpc.Server(SOROBAN_RPC_TESTNET_URL);

async function read(source: string, fn: string, ...args: xdr.ScVal[]): Promise<unknown> {
  const tx = new TransactionBuilder(new Account(source, "0"), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(new Contract(BLEND.pool).call(fn, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) throw new Error(`${fn} failed`);
  return scValToNative(sim.result.retval);
}

interface Positions {
  collateral: Map<number, bigint>;
  liabilities: Map<number, bigint>;
  supply: Map<number, bigint>;
}

const asMap = (value: unknown): Map<number, bigint> =>
  new Map(Object.entries(value as Record<string, bigint>).map(([k, v]) => [Number(k), v]));

async function positionsOf(demo: string): Promise<Positions> {
  const raw = (await read(demo, "get_positions", new Address(demo).toScVal())) as Record<
    string,
    unknown
  >;
  return {
    collateral: asMap(raw.collateral),
    liabilities: asMap(raw.liabilities),
    supply: asMap(raw.supply),
  };
}

async function runVariant(variant: 0 | 1): Promise<void> {
  const demo = Keypair.random();
  const funded = await fetch(
    `https://friendbot.stellar.org/?addr=${encodeURIComponent(demo.publicKey())}`
  );
  expect(funded.ok).toBe(true);

  const selection = { scenarios: [{ id: "blend-supply" as const, params: { variant } }] };
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
    console.log(`${step.id} (variant ${variant}): ${await executeMessStep(step, ctx)}`);
  }

  // XLM is reserve 0: collateral and debt sit under that index, and nothing else is held.
  const seeded = await positionsOf(demo.publicKey());
  expect([...seeded.collateral.keys()]).toEqual([0]);
  expect([...seeded.supply.keys()]).toEqual([]);
  expect([...seeded.liabilities.keys()]).toEqual(variant === 1 ? [0] : []);
  // No emissions on XLM's token ids, so the adapter builds no claim before the exit.
  for (const id of [0, 1]) {
    expect(await read(demo.publicKey(), "get_reserve_emissions", xdr.ScVal.scvU32(id))).toBeNull();
  }

  const reserve = (await read(
    demo.publicKey(),
    "get_reserve",
    new Address(BLEND.reserve).toScVal()
  )) as { data: { b_rate: bigint; d_rate: bigint } };
  const debt = seeded.liabilities.get(0);
  const collateral = seeded.collateral.get(0)!;
  // The adapter's steps: the repay first, at the debt plus its margin, then the withdrawal.
  const steps: { type: number; amount: bigint }[] = [];
  if (debt !== undefined) {
    const owed = (debt * reserve.data.d_rate + RATE_SCALE - BigInt(1)) / RATE_SCALE;
    steps.push({ type: BLEND_REQUEST.repay, amount: withAccrualMargin(owed) });
  }
  const underlying = (collateral * reserve.data.b_rate) / RATE_SCALE;
  steps.push({ type: BLEND_REQUEST.withdrawCollateral, amount: withAccrualMargin(underlying) });

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
  const user = new Address(demo.publicKey()).toScVal();
  for (const step of steps) {
    const request = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("address"),
        val: new Address(BLEND.reserve).toScVal(),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("amount"),
        val: nativeToScVal(step.amount, { type: "i128" }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("request_type"),
        val: xdr.ScVal.scvU32(step.type),
      }),
    ]);
    const live = await loadHorizonAccount(demo.publicKey());
    const exit = new TransactionBuilder(new Account(demo.publicKey(), live.sequenceNumber()), {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        new Contract(BLEND.pool).call("submit", user, user, user, xdr.ScVal.scvVec([request]))
      )
      .setTimeout(120)
      .build();
    const sim = await server.simulateTransaction(exit);
    if (!rpc.Api.isSimulationSuccess(sim)) throw new Error(`exit ${step.type} did not simulate`);
    const assembled = rpc.assembleTransaction(exit, sim).build();

    const close: CloseTransaction = {
      id: `exit-${step.type}`,
      order: 0,
      dependsOn: [],
      xdr: assembled.toXDR(),
      networkPassphrase: Networks.TESTNET,
      sourceSequence: live.sequenceNumber(),
      validUntilLedger: 0,
      covers: [],
      intent: {
        summary: "Blend exit",
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
    console.log(`exit request ${step.type} (variant ${variant}) ${sent.hash}: ${done.status}`);
    expect(done.status).toBe(rpc.Api.GetTransactionStatus.SUCCESS);
  }

  const left = await positionsOf(demo.publicKey());
  expect([left.collateral.size, left.liabilities.size, left.supply.size]).toEqual([0, 0, 0]);
}

test.skipIf(!RUN_INTEGRATION)(
  "a seeded Blend supply is withdrawn by a call both checks accept, and it confirms",
  async () => {
    await runVariant(0);
  },
  240_000
);

test.skipIf(!RUN_INTEGRATION)(
  "a seeded Blend borrow is repaid, then the collateral withdrawn, each call accepted and confirmed",
  async () => {
    const fits = blendBorrowFits(
      await readBlendReserve(),
      networkStroops(BLEND_SEED.supplyXlm),
      networkStroops(BLEND_SEED.borrowXlm)
    );
    if (!fits) {
      console.log("skipped: the testnet Blend pool's XLM utilization is at or over its cap");
      return;
    }
    await runVariant(1);
  },
  240_000
);
