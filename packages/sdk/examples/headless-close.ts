import {
  BASE_FEE,
  Account,
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { LumenWipeClient, runClose, type AccountState } from "@lumenwipe/sdk";
import { buildDecisions, verifyCloseTransaction } from "./verify";

const FRIENDBOT_URL = "https://friendbot.stellar.org";

const apiKey = process.env.LUMENWIPE_API_KEY;
if (!apiKey) {
  console.error("Set LUMENWIPE_API_KEY (create one at https://lumenwipe.com).");
  process.exit(1);
}

const client = new LumenWipeClient({
  baseUrl: process.env.LUMENWIPE_API_URL ?? "https://api.lumenwipe.com",
  apiKey,
  network: "testnet",
});

async function fund(address: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT_URL}/?addr=${encodeURIComponent(address)}`);
  if (!res.ok) throw new Error(`Friendbot could not fund ${address} (${res.status}).`);
}

async function waitForAccount(address: string): Promise<AccountState> {
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      return await client.getAccount(address);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error(`Account ${address} did not become readable in time.`);
}

async function addDataEntry(keypair: Keypair): Promise<void> {
  const state = await client.getAccount(keypair.publicKey());
  const tx = new TransactionBuilder(new Account(keypair.publicKey(), state.sequence), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.manageData({ name: "lumenwipe-example", value: "headless" }))
    .setTimeout(60)
    .build();
  tx.sign(keypair);
  await client.submit(tx.toEnvelope().toXDR("base64"));
}

async function main(): Promise<void> {
  const source = Keypair.random();
  const destination = Keypair.random();
  const sourceAddress = source.publicKey();
  const destinationAddress = destination.publicKey();

  console.log(`Funding ${sourceAddress} and ${destinationAddress} on testnet...`);
  await Promise.all([fund(sourceAddress), fund(destinationAddress)]);
  await Promise.all([waitForAccount(sourceAddress), waitForAccount(destinationAddress)]);
  await addDataEntry(source);

  const before = await client.getAccount(sourceAddress);
  console.log(
    `Closing ${sourceAddress}: ${before.numSubEntries} sub-entries, balance ${before.nativeBalanceLumens} XLM`
  );

  const plan = await client.closePlan({ source: sourceAddress, destination: destinationAddress });
  if (plan.blockers.length > 0) {
    throw new Error(`Plan is blocked: ${plan.blockers.map((b) => b.message).join("; ")}`);
  }
  const decisions = buildDecisions(plan.decisionPoints, destinationAddress);
  console.log(`Plan ready: ${plan.execution.estimatedTransactionCount} transaction(s).`);

  await runClose({
    getTransactions: () =>
      client.closeTransactions({
        source: sourceAddress,
        destination: destinationAddress,
        decisions,
      }),
    verify: (tx) =>
      verifyCloseTransaction(tx, { source: sourceAddress, destination: destinationAddress }),
    requiredWeight: () => 1,
    sign: async (_tx, xdr) => {
      const parsed = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
      if (!(parsed instanceof Transaction)) throw new Error("Unexpected fee-bump envelope.");
      parsed.sign(source);
      return { xdr: parsed.toEnvelope().toXDR("base64"), weight: 1 };
    },
    submit: async (_tx, xdr) => (await client.submit(xdr)).hash,
    onProgress: (message) => console.log(message),
    onConfirmed: (tx, hash) => console.log(`Confirmed ${tx.intent.summary}: ${hash}`),
  });

  const received = await client.getAccount(destinationAddress);
  console.log(`Closed. Destination now holds ${received.nativeBalanceLumens} XLM.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
