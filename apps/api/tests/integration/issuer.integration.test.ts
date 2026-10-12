import "@/env";
import { expect, test } from "bun:test";
import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { assessIssuance, type IssuanceSummary } from "@/lib/close-api/issuance-preflight";

const FRIENDBOT = "https://friendbot.stellar.org";
const HORIZON_URL = "https://horizon-testnet.stellar.org";
const POLL_INTERVAL_MS = 2_500;
const POLL_BUDGET_MS = 90_000;

// Funds throwaway testnet accounts through friendbot and submits real transactions, so it runs
// under the same pair of flags as the other funded tests. Testnet only.
const RUN_INTEGRATION =
  !!process.env.LUMENWIPE_RUN_INTEGRATION && !!process.env.LUMENWIPE_INTEGRATION_FUNDED;

const deps = { horizon: () => ({ baseUrl: HORIZON_URL }) };

async function fund(publicKey: string): Promise<void> {
  const deadline = Date.now() + POLL_BUDGET_MS;
  for (;;) {
    const res = await fetch(`${FRIENDBOT}?addr=${publicKey}`).catch(() => null);
    if (res?.ok) return;
    if (Date.now() > deadline) throw new Error(`friendbot did not fund ${publicKey}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + POLL_BUDGET_MS;
  let last = await read().catch(() => null);
  while (Date.now() < deadline) {
    if (last !== null && done(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    last = await read().catch(() => last);
  }
  if (last === null) throw new Error("the read never succeeded");
  return last;
}

async function submit(
  server: Horizon.Server,
  signer: Keypair,
  operations: ReturnType<typeof Operation.payment>[]
): Promise<Horizon.HorizonApi.SubmitTransactionResponse> {
  const account = await server.loadAccount(signer.publicKey());
  const builder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  }).setTimeout(60);
  for (const op of operations) builder.addOperation(op);
  const tx = builder.build();
  tx.sign(signer);
  return server.submitTransaction(tx);
}

test.skipIf(!RUN_INTEGRATION)(
  "an issuer's outstanding supply is counted, and a payment to a merged issuer succeeds as a burn",
  async () => {
    const server = new Horizon.Server(HORIZON_URL);
    const issuer = Keypair.random();
    const holder = Keypair.random();
    await Promise.all([fund(issuer.publicKey()), fund(holder.publicKey())]);
    const asset = new Asset("LWISSUER", issuer.publicKey());

    await submit(server, holder, [Operation.changeTrust({ asset })]);
    await submit(server, issuer, [
      Operation.payment({ destination: holder.publicKey(), asset, amount: "10" }),
    ]);

    const issuance = await until(
      () => assessIssuance(issuer.publicKey(), "testnet", deps),
      (summary: IssuanceSummary | null) => summary !== null
    );
    expect(issuance).toEqual({ assetCount: 1, holderCount: 1 });
    expect(await assessIssuance(holder.publicKey(), "testnet", deps)).toBeNull();

    await submit(server, issuer, [Operation.accountMerge({ destination: holder.publicKey() })]);
    await until(
      () => fetch(`${HORIZON_URL}/accounts/${issuer.publicKey()}`).then((r) => r.status),
      (status: number) => status === 404
    );

    // Paying an asset to its issuer is a burn the ledger accepts even once that account is gone,
    // so the issuer's absence does not stop a holder from removing the balance.
    const burn = await submit(server, holder, [
      Operation.payment({ destination: issuer.publicKey(), asset, amount: "10" }),
    ]);
    expect(burn.successful).toBe(true);
    const after = await server.loadAccount(holder.publicKey());
    const line = after.balances.find(
      (b) => b.asset_type === "credit_alphanum12" && b.asset_code === "LWISSUER"
    );
    expect(line?.balance).toBe("0.0000000");
  },
  300_000
);
