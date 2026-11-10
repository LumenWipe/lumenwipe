import { expect, test } from "bun:test";
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  nativeToScVal,
  Networks,
  Operation,
  rpc,
  scValToNative,
  TransactionBuilder,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import type { CloseTransaction } from "@lumenwipe/sdk";
import { loadHorizonAccount, SOROBAN_RPC_TESTNET_URL } from "@/lib/horizon-submit";
import { executeMessStep, type MessContext } from "@/lib/mess-builders";
import { phoenixReads, phoenixSwapFits } from "@/lib/phoenix-pool";
import { networkStroops } from "@/lib/stroops";
import { PHOENIX, PHOENIX_SEED, resolvePlan } from "@/lib/scenarios";
import { expectationFromSession, verifyDemolishTransaction } from "@/lib/verify";

// Manual only: `bun run --filter '@lumenwipe/playground' test:integration`. Needs real testnet
// Friendbot, Horizon and Soroban RPC access; gated inside the test like the other integration
// tests, so a bare `bun test` never reaches the network.
//
// A fresh Friendbot account runs the Phoenix scenario's seeding steps (the swap, the deposit and,
// bonded, the bond) through the real executors, then builds the exit the API's adapter builds
// (apps/api/src/lib/defi-exits/phoenix.ts) from the account's live state: every stake unbonded
// first, one call each, then `withdraw_liquidity` for the plain shares with floors at the
// position's share of each reserve less the adapter's slippage. Each is simulated and assembled by
// the RPC and held to both of the playground's checks before it is signed and sent, so the
// authorization tree checked is the one testnet really returns, and it is logged as returned.
const RUN_INTEGRATION = !!process.env.LUMENWIPE_RUN_INTEGRATION;

const SLIPPAGE_BPS = BigInt(50);
const server = new rpc.Server(SOROBAN_RPC_TESTNET_URL);
const reads = phoenixReads(server);

async function read(source: string, contract: string, fn: string, ...args: xdr.ScVal[]) {
  const tx = new TransactionBuilder(new Account(source, "0"), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(new Contract(contract).call(fn, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result) throw new Error(`${fn} failed`);
  return scValToNative(sim.result.retval) as unknown;
}

/** An authorization tree as `contract.function(args)`, nested, for the log. */
function treeOf(invocation: xdr.SorobanAuthorizedInvocation): unknown {
  const fn = invocation.function;
  if (fn.type !== "sorobanAuthorizedFunctionTypeContractFn") return "not a contract call";
  const call = fn.contractFn;
  return {
    call: `${Address.fromScAddress(call.contractAddress).toString()}.${call.functionName.toString()}`,
    args: call.args.map((a) => String(scValToNative(a) as unknown)),
    subs: invocation.subInvocations.map(treeOf),
  };
}

async function runVariant(variant: 0 | 1): Promise<void> {
  const demo = Keypair.random();
  const funded = await fetch(
    `https://friendbot.stellar.org/?addr=${encodeURIComponent(demo.publicKey())}`
  );
  expect(funded.ok).toBe(true);

  const selection = { scenarios: [{ id: "phoenix-lp" as const, params: { variant } }] };
  const ctx: MessContext = {
    demo,
    ephemeralIssuers: new Map(),
    persistentIssuer: Keypair.random(),
    mmPublic: Keypair.random().publicKey(),
    transferRecipient: null,
    helpers: new Map(),
    recordSigner: async () => {},
    recordClaimableBalances: async () => {},
    allowances: [],
    recordAllowance: async () => {},
  };
  for (const step of resolvePlan(selection).steps.filter((s) => s.id !== "SETUP")) {
    console.log(`${step.id} (variant ${variant}): ${await executeMessStep(step, ctx)}`);
  }

  const account = demo.publicKey();
  const plain = await reads.balance(PHOENIX.shareToken, account);
  const staked = (await read(
    account,
    PHOENIX.stake,
    "query_staked",
    new Address(account).toScVal()
  )) as {
    stakes: { stake: bigint; stake_timestamp: bigint }[];
  };
  console.log(`seeded (variant ${variant}): ${plain} plain shares, stakes ${staked.stakes.length}`);
  // Half bonded: the plain balance the API's testnet read finds the position by is never zero.
  expect(plain).toBeGreaterThan(BigInt(0));
  expect(staked.stakes.length).toBe(variant === 1 ? 1 : 0);
  if (variant === 1) expect(staked.stakes[0]!.stake).toBe(plain);

  const expected = expectationFromSession(
    {
      demoPublic: account,
      ephemeralIssuers: [],
      recordedSigners: [],
      selection,
      transferRecipient: null,
      helperAccounts: [],
      claimableBalances: [],
    },
    Keypair.random().publicKey(),
    ctx.persistentIssuer.publicKey(),
    null
  );
  const user = new Address(account).toScVal();
  const i128 = (v: bigint): xdr.ScVal => nativeToScVal(v, { type: "i128" });

  async function exit(label: string, op: xdr.Operation): Promise<void> {
    const live = await loadHorizonAccount(account);
    const built = new TransactionBuilder(new Account(account, live.sequenceNumber()), {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(op)
      .setTimeout(120)
      .build();
    const sim = await server.simulateTransaction(built);
    if (!rpc.Api.isSimulationSuccess(sim)) throw new Error(`${label} did not simulate`);
    const assembled: Transaction = rpc.assembleTransaction(built, sim).build();
    const invoke = assembled.operations[0] as Operation.InvokeHostFunction;
    console.log(
      `${label} auth:`,
      JSON.stringify((invoke.auth ?? []).map((e) => treeOf(e.rootInvocation)))
    );
    const close: CloseTransaction = {
      id: label,
      order: 0,
      dependsOn: [],
      xdr: assembled.toXDR(),
      networkPassphrase: Networks.TESTNET,
      sourceSequence: live.sequenceNumber(),
      validUntilLedger: 0,
      covers: [],
      intent: {
        summary: "Phoenix exit",
        source: account,
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
    console.log(`${label} (variant ${variant}) ${sent.hash}: ${done.status}`);
    expect(done.status).toBe(rpc.Api.GetTransactionStatus.SUCCESS);
  }

  for (const stake of staked.stakes) {
    await exit(
      "unbond",
      new Contract(PHOENIX.stake).call(
        "unbond",
        user,
        i128(stake.stake),
        nativeToScVal(stake.stake_timestamp, { type: "u64" })
      )
    );
  }

  const shares = await reads.balance(PHOENIX.shareToken, account);
  const info = (await read(account, PHOENIX.pool, "query_pool_info")) as {
    asset_a: { amount: bigint };
    asset_b: { amount: bigint };
    asset_lp_share: { amount: bigint };
  };
  const floor = (reserve: bigint): bigint =>
    (((shares * reserve) / info.asset_lp_share.amount) * (BigInt(10_000) - SLIPPAGE_BPS)) /
    BigInt(10_000);
  await exit(
    "withdraw_liquidity",
    new Contract(PHOENIX.pool).call(
      "withdraw_liquidity",
      user,
      i128(shares),
      i128(floor(info.asset_a.amount)),
      i128(floor(info.asset_b.amount)),
      xdr.ScVal.scvVoid()
    )
  );

  expect(await reads.balance(PHOENIX.shareToken, account)).toBe(BigInt(0));
  const left = (await read(account, PHOENIX.stake, "query_staked", user)) as { stakes: unknown[] };
  expect(left.stakes).toEqual([]);
  // The LWPHX paid back stays with the address: the close answers it `acknowledge_residue`.
  console.log(`LWPHX left (variant ${variant}): ${await reads.balance(PHOENIX.tokenA, account)}`);
}

async function poolSells(): Promise<boolean> {
  const fits = phoenixSwapFits(await reads.swapQuote(networkStroops(PHOENIX_SEED.swapXlm)));
  if (!fits) console.log("skipped: the testnet Phoenix pool cannot sell LWPHX within the gate");
  return fits;
}

test.skipIf(!RUN_INTEGRATION)(
  "a seeded Phoenix position is withdrawn by a call both checks accept, and it confirms",
  async () => {
    if (await poolSells()) await runVariant(0);
  },
  240_000
);

test.skipIf(!RUN_INTEGRATION)(
  "a bonded Phoenix position is unbonded, then withdrawn, each call accepted and confirmed",
  async () => {
    if (await poolSells()) await runVariant(1);
  },
  240_000
);
