// Must stay the first import, exactly as in src/main.ts - see sponsorship.integration.test.ts
// for the full rationale (config/networks.ts reads process.env at import time).
import "@/env";
import { expect, test } from "bun:test";
import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  LiquidityPoolAsset,
  LiquidityPoolFeeV18,
  Networks,
  Operation,
  TransactionBuilder,
  getLiquidityPoolId,
  type xdr,
} from "@stellar/stellar-sdk";
import type { AccountState } from "@lumenwipe/types";
import { ALL_ON } from "@/config/kill-switches";
import { getAccountState } from "@/lib/stellar/account-state";
import { buildPlan } from "@/lib/stellar/tx-builder";
import { buildCloseTransactions } from "@/lib/close-api/build-transactions";

const FRIENDBOT = "https://friendbot.stellar.org";
const HORIZON_URL = "https://horizon-testnet.stellar.org";
// Funds throwaway testnet accounts through friendbot and submits real transactions against pools
// this run creates from assets it issues itself, never a shared contract or pool. Runs under the
// same pair of flags as the other funded tests.
const RUN_INTEGRATION =
  !!process.env.LUMENWIPE_RUN_INTEGRATION && !!process.env.LUMENWIPE_INTEGRATION_FUNDED;
const POLL_ATTEMPTS = 12;
const POLL_DELAY_MS = 2500;

async function fund(publicKey: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT}?addr=${publicKey}`);
  if (!res.ok) throw new Error(`friendbot funding failed for ${publicKey}: ${res.status}`);
}

async function submit(
  server: Horizon.Server,
  source: Keypair,
  operations: xdr.Operation[],
  signers: Keypair[] = [source]
): Promise<string> {
  const account = await server.loadAccount(source.publicKey());
  const builder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  }).setTimeout(60);
  for (const op of operations) builder.addOperation(op);
  const tx = builder.build();
  for (const signer of signers) tx.sign(signer);
  return (await server.submitTransaction(tx)).hash;
}

/** Reads the account until `done` holds, absorbing RPC lagging the Horizon-compatible endpoint. */
async function readUntil(
  address: string,
  done: (state: AccountState) => boolean
): Promise<AccountState> {
  let last: AccountState | null = null;
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    try {
      last = await getAccountState(address, "testnet");
      if (done(last)) return last;
    } catch {
      // A read that fails while the ledger catches up is retried like a stale one.
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_DELAY_MS));
  }
  if (last) return last;
  throw new Error(`the account ${address} could not be read`);
}

async function signAndSubmit(
  server: Horizon.Server,
  unsignedXdr: string,
  signer: Keypair
): Promise<string> {
  const tx = TransactionBuilder.fromXDR(unsignedXdr, Networks.TESTNET);
  tx.sign(signer);
  const result = await server.submitTransaction(tx);
  expect(result.successful).toBe(true);
  return result.hash;
}

test.skipIf(!RUN_INTEGRATION)(
  "an account holding shares in an XLM pool and a pool of two issued assets closes end to end",
  async () => {
    const server = new Horizon.Server(HORIZON_URL);
    const issuerA = Keypair.random();
    const issuerB = Keypair.random();
    const holder = Keypair.random();
    const destination = Keypair.random();
    await Promise.all([issuerA, issuerB, holder, destination].map((k) => fund(k.publicKey())));

    const lwpa = new Asset("LWPA", issuerA.publicKey());
    const lwpb = new Asset("LWPB", issuerB.publicKey());
    const xlmPool = new LiquidityPoolAsset(Asset.native(), lwpa, LiquidityPoolFeeV18);
    const issuedPool = new LiquidityPoolAsset(lwpa, lwpb, LiquidityPoolFeeV18);
    const idOf = (line: LiquidityPoolAsset): string =>
      Buffer.from(
        getLiquidityPoolId("constant_product", line.getLiquidityPoolParameters())
      ).toString("hex");

    await submit(server, holder, [
      Operation.changeTrust({ asset: lwpa }),
      Operation.changeTrust({ asset: lwpb }),
    ]);
    await submit(
      server,
      issuerA,
      [
        Operation.payment({ destination: holder.publicKey(), asset: lwpa, amount: "1000" }),
        Operation.payment({
          destination: holder.publicKey(),
          asset: lwpb,
          amount: "1000",
          source: issuerB.publicKey(),
        }),
      ],
      [issuerA, issuerB]
    );
    await submit(server, holder, [
      Operation.changeTrust({ asset: xlmPool }),
      Operation.changeTrust({ asset: issuedPool }),
      Operation.liquidityPoolDeposit({
        liquidityPoolId: idOf(xlmPool),
        maxAmountA: "100",
        maxAmountB: "200",
        minPrice: "0.4",
        maxPrice: "0.6",
      }),
      Operation.liquidityPoolDeposit({
        liquidityPoolId: idOf(issuedPool),
        maxAmountA: "300",
        maxAmountB: "400",
        minPrice: "0.7",
        maxPrice: "0.8",
      }),
    ]);

    const held = await readUntil(
      holder.publicKey(),
      (s) => s.poolShares.length === 2 && s.poolShares.every((p) => p.pool !== null)
    );
    expect(held.poolShares.map((p) => p.poolId).sort()).toEqual(
      [idOf(xlmPool), idOf(issuedPool)].sort()
    );

    const dispositions = {
      [`LWPA:${issuerA.publicKey()}`]: "issuer",
      [`LWPB:${issuerB.publicKey()}`]: "issuer",
    } as const;
    const plan = buildPlan(ALL_ON, held, false, false, {}, undefined, dispositions);
    expect(plan.blockers).toEqual([]);
    expect(plan.steps.filter((s) => s.type === "WITHDRAW_POOL_SHARES")).toHaveLength(2);

    const poolRound = await buildCloseTransactions(
      ALL_ON,
      held,
      destination.publicKey(),
      dispositions,
      "testnet"
    );
    expect(poolRound.requiresAnotherCall).toBe(true);
    expect(poolRound.transactions).toHaveLength(1);
    expect(poolRound.transactions[0]!.covers).toEqual(["WITHDRAW_POOL_SHARES"]);
    const withdrawHash = await signAndSubmit(server, poolRound.transactions[0]!.xdr, holder);

    const withdrawn = await readUntil(
      holder.publicKey(),
      (s) => s.poolShares.length === 0 && s.trustlines.every((t) => Number(t.balance) > 0)
    );
    expect(withdrawn.poolShares).toEqual([]);

    const close = await buildCloseTransactions(
      ALL_ON,
      withdrawn,
      destination.publicKey(),
      dispositions,
      "testnet"
    );
    expect(close.requiresAnotherCall).toBe(false);
    expect(close.transactions).toHaveLength(1);
    const closeHash = await signAndSubmit(server, close.transactions[0]!.xdr, holder);

    await expect(server.loadAccount(holder.publicKey())).rejects.toBeDefined();
    console.info("pool withdrawal close: withdraw %s, close %s", withdrawHash, closeHash);
  },
  240000
);
