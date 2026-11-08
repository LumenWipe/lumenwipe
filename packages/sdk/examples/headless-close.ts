import {
  BASE_FEE,
  Account,
  Keypair,
  Operation,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { LumenWipeClient, runClose } from "@lumenwipe/sdk";
import { buildDecisions, verifyCloseTransaction } from "./verify";
import {
  PASSPHRASES,
  fund,
  requireEnv,
  requiredWeightFor,
  runMain,
  signerWeight,
  waitForAccount,
  type SignerState,
} from "./support";

// Throwaway accounts funded by Friendbot: this example never runs on mainnet.
const NETWORK = "testnet";
const networkPassphrase = PASSPHRASES[NETWORK];

const client = new LumenWipeClient({
  baseUrl: process.env.LUMENWIPE_API_URL ?? "https://api.lumenwipe.com",
  apiKey: requireEnv("LUMENWIPE_API_KEY", "create one at https://lumenwipe.com/api-keys"),
  network: NETWORK,
});

async function fundAndWait(address: string): Promise<void> {
  // Polling starts at once, so a rejected key fails the run before Friendbot answers.
  await Promise.all([fund(address), waitForAccount((a) => client.getAccount(a), address)]);
}

async function addDataEntry(keypair: Keypair): Promise<void> {
  const state = await client.getAccount(keypair.publicKey());
  const tx = new TransactionBuilder(new Account(keypair.publicKey(), state.sequence), {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(Operation.manageData({ name: "lumenwipe-example", value: "headless" }))
    .setTimeout(60)
    .build();
  tx.sign(keypair);
  await client.submit(tx.toEnvelope().toXdr("base64"));
}

async function main(): Promise<void> {
  const source = Keypair.random();
  const destination = Keypair.random();
  const sourceAddress = source.publicKey();
  const destinationAddress = destination.publicKey();

  console.log(`Funding ${sourceAddress} and ${destinationAddress} on ${NETWORK}...`);
  await Promise.all([fundAndWait(sourceAddress), fundAndWait(destinationAddress)]);
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
  const count = plan.execution.estimatedTransactionCount;
  console.log(count === null ? "Plan ready." : `Plan ready: ${count} transaction(s).`);

  // Signing weight is judged against the signers and thresholds each round was built from.
  let signerState: SignerState = before;

  await runClose({
    getTransactions: async () => {
      const round = await client.closeTransactions({
        source: sourceAddress,
        destination: destinationAddress,
        decisions,
      });
      signerState = round.sourceAccount ?? (await client.getAccount(sourceAddress));
      return round;
    },
    verify: (tx) =>
      verifyCloseTransaction(tx, {
        account: before,
        destination: destinationAddress,
        network: NETWORK,
      }),
    requiredWeight: (tx) => requiredWeightFor(tx, signerState, networkPassphrase),
    sign: async (_tx, xdr) => {
      const parsed = TransactionBuilder.fromXdr(xdr, networkPassphrase);
      if (!(parsed instanceof Transaction)) throw new Error("Unexpected fee-bump envelope.");
      parsed.sign(source);
      return {
        xdr: parsed.toEnvelope().toXdr("base64"),
        weight: signerWeight(signerState, sourceAddress),
      };
    },
    submit: async (_tx, xdr) => (await client.submit(xdr)).hash,
    onProgress: (message) => console.log(message),
    onConfirmed: (tx, hash) => console.log(`Confirmed ${tx.intent.summary}: ${hash}`),
  });

  const received = await client.getAccount(destinationAddress);
  console.log(`Closed. Destination now holds ${received.nativeBalanceLumens} XLM.`);
}

runMain(main);
