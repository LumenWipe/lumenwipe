import {
  BASE_FEE,
  Account,
  Keypair,
  Operation,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import {
  LumenWipeApiError,
  LumenWipeClient,
  runClose,
  type CloseTransaction,
  type MediatorCheckResult,
} from "@lumenwipe/sdk";
import { requiresMediator } from "@lumenwipe/verify";
import { buildDecisions, verifyCloseTransaction } from "./verify";
import {
  MediatorUnavailableError,
  PASSPHRASES,
  assertCosignOnlyAddedSignature,
  fund,
  requireEnv,
  requiredWeightFor,
  runMain,
  signerWeight,
  waitForAccount,
  type ExampleNetwork,
  type SignerState,
} from "./support";

// Throwaway accounts funded by Friendbot: this example never runs on mainnet.
export const NETWORK: ExampleNetwork = "testnet";

/**
 * An exchange deposit address the registry bundled in `@lumenwipe/verify` lists as unable to
 * receive an account merge (Coinbase, text memo). On testnet it is only an address: the testnet
 * XLM forwarded to it is worthless, and nobody here holds its key.
 */
export const EXCHANGE_DESTINATION = "GB5CLRWUCBQ6DFK2LR5ZMWJ7QCVEB3XKMPTQUYCDIYB4DRZJBEW6M26D";

/** The deposit memo a user would copy from the exchange. */
export const DEPOSIT_MEMO = { value: "lumenwipe-example", type: "text" } as const;

/** Refuses to run on any network but testnet. */
export function assertTestnetOnly(network: ExampleNetwork): void {
  if (network !== "testnet") {
    throw new Error(`This example closes throwaway accounts on testnet only, not ${network}.`);
  }
}

/**
 * Stops before anything is built when the close cannot finish: the destination must need the
 * intermediary according to the bundled registry, and the API must be able to co-sign for it.
 * Without this, the cleanup round would land and the merge would then be refused.
 */
export function assertMediatorReady(check: MediatorCheckResult, destination: string): void {
  if (!requiresMediator(destination, NETWORK)) {
    throw new Error(
      `${destination} is not an exchange the bundled registry routes through the intermediary.`
    );
  }
  if (!check.available || !check.registryFresh) {
    throw new MediatorUnavailableError(destination, check.available, check.registryFresh);
  }
}

/**
 * Whether this signed transaction needs the intermediary's co-signature: the destination the
 * user typed needs it according to the bundled registry, and the transaction is the merge.
 * Decided from the caller's input and the decoded transaction, never from the API's response.
 */
export function needsCosign(xdr: string, destination: string, networkPassphrase: string): boolean {
  if (!requiresMediator(destination, NETWORK)) return false;
  const parsed = TransactionBuilder.fromXdr(xdr, networkPassphrase);
  return (
    parsed instanceof Transaction && parsed.operations.some((op) => op.type === "accountMerge")
  );
}

export interface CosignDeps {
  destination: string;
  networkPassphrase: string;
  /** Returns the envelope with the intermediary's signature added (`client.mediatorSign`). */
  mediatorSign: (signedXdr: string) => Promise<string>;
}

/** `runClose`'s `prepare` step: asks for the co-signature on the merge, and refuses an envelope
 *  that came back changed or without a new signature. Every other transaction passes as signed. */
export function cosignMerge({ destination, networkPassphrase, mediatorSign }: CosignDeps) {
  return async (_tx: CloseTransaction, signedXdr: string): Promise<string> => {
    if (!needsCosign(signedXdr, destination, networkPassphrase)) return signedXdr;
    const cosigned = await mediatorSign(signedXdr);
    assertCosignOnlyAddedSignature(signedXdr, cosigned, networkPassphrase);
    return cosigned;
  };
}

async function main(): Promise<void> {
  assertTestnetOnly(NETWORK);
  const networkPassphrase = PASSPHRASES[NETWORK];
  const client = new LumenWipeClient({
    baseUrl: process.env.LUMENWIPE_API_URL ?? "https://api.lumenwipe.com",
    apiKey: requireEnv("LUMENWIPE_API_KEY", "create one at https://lumenwipe.com/api-keys"),
    network: NETWORK,
  });
  const destination = EXCHANGE_DESTINATION;

  async function fundAndWait(address: string): Promise<void> {
    await Promise.all([fund(address), waitForAccount((a) => client.getAccount(a), address)]);
  }

  // The forward is a payment, which needs an existing account. A testnet reset removes it.
  async function ensureExists(address: string): Promise<void> {
    try {
      await client.getAccount(address);
    } catch (error) {
      if (!(error instanceof LumenWipeApiError) || error.code !== "account_not_found") throw error;
      console.log(`Creating ${address} on ${NETWORK} with Friendbot...`);
      await fundAndWait(address);
    }
  }

  assertMediatorReady(await client.mediatorCheck(destination), destination);

  const source = Keypair.random();
  const sourceAddress = source.publicKey();
  console.log(`Funding ${sourceAddress} on ${NETWORK}...`);
  await Promise.all([fundAndWait(sourceAddress), ensureExists(destination)]);

  const state = await client.getAccount(sourceAddress);
  const dataTx = new TransactionBuilder(new Account(sourceAddress, state.sequence), {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(Operation.manageData({ name: "lumenwipe-example", value: "exchange" }))
    .setTimeout(60)
    .build();
  dataTx.sign(source);
  await client.submit(dataTx.toEnvelope().toXdr("base64"));

  const before = await client.getAccount(sourceAddress);
  console.log(
    `Closing ${sourceAddress} to ${destination}: ${before.numSubEntries} sub-entries, balance ${before.nativeBalanceLumens} XLM`
  );

  const plan = await client.closePlan({ source: sourceAddress, destination });
  if (plan.blockers.length > 0) {
    throw new Error(`Plan is blocked: ${plan.blockers.map((b) => b.message).join("; ")}`);
  }
  const decisions = buildDecisions(plan.decisionPoints, destination);

  let signerState: SignerState = before;
  const hashes: string[] = [];

  await runClose({
    getTransactions: async () => {
      const round = await client.closeTransactions({
        source: sourceAddress,
        destination,
        decisions,
        memo: DEPOSIT_MEMO.value,
        memoType: DEPOSIT_MEMO.type,
      });
      signerState = round.sourceAccount ?? (await client.getAccount(sourceAddress));
      return round;
    },
    verify: (tx) =>
      verifyCloseTransaction(tx, {
        account: before,
        destination,
        network: NETWORK,
        memo: DEPOSIT_MEMO,
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
    prepare: cosignMerge({
      destination,
      networkPassphrase,
      mediatorSign: async (xdr) => (await client.mediatorSign(xdr)).transaction,
    }),
    submit: async (_tx, xdr) => (await client.submit(xdr)).hash,
    onProgress: (message) => console.log(message),
    onConfirmed: (tx, hash) => {
      hashes.push(hash);
      console.log(`Confirmed ${tx.intent.summary}: ${hash}`);
    },
  });

  // What reached the exchange, read from the ledger: only the intermediary's forward counts.
  const delivered = await client.closeDelivered(destination, hashes);
  const forwards = delivered.entries.filter(
    (e) => e.status === "delivered" && BigInt(e.amountStroops) > BigInt(0)
  );
  if (forwards.length === 0) {
    throw new Error(`No XLM reached ${destination}: ${JSON.stringify(delivered.entries)}`);
  }
  for (const entry of forwards) {
    if (entry.status === "delivered") {
      console.log(`Delivered ${entry.amountStroops} stroops to ${destination} in ${entry.hash}.`);
    }
  }
}

if (import.meta.main) runMain(main);
