/**
 * End-to-end check of the sponsored-fee flow on TESTNET, used after a fee sponsor rotation.
 *
 * It funds a throwaway source and destination through friendbot, builds a zero-fee account merge
 * of the source into the destination with a 120-second time bound, signs it, asks the running
 * app's /fee-bump/sponsor proxy to wrap it, checks that the returned fee bump is paid by the
 * expected sponsor, submits it, and reads `fee_account` back from Horizon. Only public keys are
 * printed; the throwaway seeds never leave the process.
 *
 * Run it from apps/api with the sponsor address the API should be using:
 *
 *   APP_URL=http://localhost:3000 FEE_ACCOUNT_ADDRESS_TESTNET=<G...> bun run test:sponsor
 */
import {
  Account,
  FeeBumpTransaction,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  type Transaction,
} from "@stellar/stellar-sdk";

const HORIZON = "https://horizon-testnet.stellar.org";
const FRIENDBOT = "https://friendbot.stellar.org";
const PASSPHRASE = Networks.TESTNET;
const VALIDITY_SECONDS = 120;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** The zero-fee, time-bounded merge the sponsor endpoint accepts for a wind-down. */
export function buildSponsoredClose(
  source: string,
  sequence: string,
  destination: string
): Transaction {
  return new TransactionBuilder(new Account(source, sequence), {
    fee: "0",
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(Operation.accountMerge({ destination }))
    .setTimeout(VALIDITY_SECONDS)
    .build();
}

async function fund(fetchFn: Fetch, address: string): Promise<void> {
  const res = await fetchFn(`${FRIENDBOT}/?addr=${encodeURIComponent(address)}`);
  if (!res.ok) throw new Error(`friendbot answered ${res.status} for ${address}`);
}

async function sequenceOf(fetchFn: Fetch, address: string): Promise<string | null> {
  const res = await fetchFn(`${HORIZON}/accounts/${address}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Horizon answered ${res.status} for account ${address}`);
  return ((await res.json()) as { sequence: string }).sequence;
}

export async function main(
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: Fetch = fetch,
  log: (line: string) => void = (line) => process.stdout.write(`${line}\n`)
): Promise<number> {
  try {
    const app = env.APP_URL || "http://localhost:3000";
    const expected = env.FEE_ACCOUNT_ADDRESS_TESTNET ?? "";
    if (!StrKey.isValidEd25519PublicKey(expected)) {
      throw new Error("set FEE_ACCOUNT_ADDRESS_TESTNET to the sponsor's G... address");
    }

    const source = Keypair.random();
    const destination = Keypair.random();
    log(`App:         ${app}`);
    log(`Sponsor:     ${expected}`);
    log(`Source:      ${source.publicKey()}`);
    log(`Destination: ${destination.publicKey()}`);

    await fund(fetchFn, source.publicKey());
    await fund(fetchFn, destination.publicKey());
    const sequence = await sequenceOf(fetchFn, source.publicKey());
    if (sequence === null) throw new Error("the funded source account is not on Horizon");

    const inner = buildSponsoredClose(source.publicKey(), sequence, destination.publicKey());
    inner.sign(source);

    const sponsorRes = await fetchFn(`${app}/api/testnet/fee-bump/sponsor`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transaction: inner.toEnvelope().toXDR("base64") }),
    });
    if (!sponsorRes.ok) {
      const body = (await sponsorRes.text()).replace(/\s+/g, " ").slice(0, 200);
      throw new Error(`fee-bump/sponsor answered ${sponsorRes.status}: ${body}`);
    }
    const { transaction } = (await sponsorRes.json()) as { transaction?: string };
    const wrapped = transaction ? TransactionBuilder.fromXDR(transaction, PASSPHRASE) : null;
    if (!(wrapped instanceof FeeBumpTransaction)) {
      throw new Error("fee-bump/sponsor did not return a fee-bump envelope");
    }
    if (wrapped.feeSource !== expected) {
      throw new Error(`the fee bump is paid by ${wrapped.feeSource}, not ${expected}`);
    }
    if (!Buffer.from(wrapped.innerTransaction.hash()).equals(Buffer.from(inner.hash()))) {
      throw new Error("the fee bump wraps a different transaction than the one sent");
    }

    const submitRes = await fetchFn(`${HORIZON}/transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ tx: transaction! }),
    });
    const submitted = (await submitRes.json()) as {
      successful?: boolean;
      hash?: string;
      extras?: { result_codes?: unknown };
    };
    if (!submitRes.ok || !submitted.successful || !submitted.hash) {
      throw new Error(
        `submit failed: ${JSON.stringify(submitted.extras?.result_codes ?? submitted)}`
      );
    }
    log(`Fee bump:    ${submitted.hash}`);

    const txRes = await fetchFn(`${HORIZON}/transactions/${submitted.hash}`);
    if (!txRes.ok) throw new Error(`Horizon answered ${txRes.status} for the fee bump`);
    const landed = (await txRes.json()) as { fee_account?: string; source_account?: string };
    if (landed.fee_account !== expected) {
      throw new Error(`Horizon shows fee_account ${landed.fee_account}, not ${expected}`);
    }
    if (landed.source_account !== source.publicKey()) {
      throw new Error(`Horizon shows source_account ${landed.source_account}`);
    }
    if ((await sequenceOf(fetchFn, source.publicKey())) !== null) {
      throw new Error("the source account still exists after the merge");
    }

    log(`PASS: fee_account ${expected}, source ${source.publicKey()} closed`);
    return 0;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`FAIL: ${reason.split("\n")[0]}\n`);
    return 1;
  }
}

if (import.meta.main) process.exit(await main());
