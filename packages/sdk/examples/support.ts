import { Networks, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import {
  InsufficientSignatureWeightError,
  LumenWipeApiError,
  LumenWipeTimeoutError,
  type AccountSigner,
  type AccountState,
  type AccountThresholds,
  type CloseTransaction,
  type FetchLike,
} from "@lumenwipe/sdk";

export type ExampleNetwork = "testnet" | "mainnet";

export const PASSPHRASES: Record<ExampleNetwork, string> = {
  testnet: Networks.TESTNET,
  mainnet: Networks.PUBLIC,
};

const FRIENDBOT_URL = "https://friendbot.stellar.org";
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_DELAY_MS = 30_000;

/** Friendbot answered with a non-2xx status. */
export class FriendbotError extends Error {
  constructor(
    readonly status: number,
    address: string
  ) {
    super(`Friendbot could not fund ${address} (${status}).`);
    this.name = "FriendbotError";
  }
}

/**
 * Worth trying again: an account the network has not shown yet, a throttle, a 5xx, a timeout or
 * a connection that never got a response. Anything else (a bad key, a rejected request, an abort)
 * is a fact that waiting will not change.
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof LumenWipeApiError) {
    return error.code === "account_not_found" || RETRYABLE_STATUSES.has(error.status);
  }
  if (error instanceof FriendbotError) return RETRYABLE_STATUSES.has(error.status);
  return error instanceof LumenWipeTimeoutError || error instanceof TypeError;
}

/** Every attempt failed with a retryable error; `cause` is the last one. */
export class RetriesExhaustedError extends Error {
  constructor(
    message: string,
    readonly cause: unknown
  ) {
    super(message);
    this.name = "RetriesExhaustedError";
  }
}

export interface RetryConfig {
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Runs `operation`, retrying only retryable errors and rethrowing any other at once. */
export async function withRetry<T>(
  label: string,
  operation: () => Promise<T>,
  { attempts = 15, delayMs = 1000, sleep = defaultSleep }: RetryConfig = {}
): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryable(error)) throw error;
      last = error;
      if (attempt < attempts) {
        const hinted = error instanceof LumenWipeApiError ? error.retryAfterMs : undefined;
        await sleep(Math.min(hinted ?? delayMs, MAX_DELAY_MS));
      }
    }
  }
  throw new RetriesExhaustedError(`${label} did not succeed after ${attempts} attempts.`, last);
}

export function waitForAccount(
  read: (address: string) => Promise<AccountState>,
  address: string,
  config?: RetryConfig
): Promise<AccountState> {
  return withRetry(`Reading ${address}`, () => read(address), config);
}

export function fund(
  address: string,
  { fetch: doFetch = fetch, ...config }: RetryConfig & { fetch?: FetchLike } = {}
): Promise<void> {
  return withRetry(
    `Funding ${address}`,
    async () => {
      const res = await doFetch(`${FRIENDBOT_URL}/?addr=${encodeURIComponent(address)}`);
      if (!res.ok) throw new FriendbotError(res.status, address);
    },
    { attempts: 3, ...config }
  );
}

export interface SignerState {
  signers: AccountSigner[];
  thresholds: AccountThresholds;
}

type ThresholdCategory = keyof AccountThresholds;
const RANK: Record<ThresholdCategory, number> = { low: 0, med: 1, high: 2 };

/** stellar-core's threshold level per operation. Unknown types fail closed to `high`. */
function thresholdCategory(op: Transaction["operations"][number]): ThresholdCategory {
  switch (op.type) {
    case "accountMerge":
      return "high";
    case "setOptions":
      return op.signer !== undefined ||
        op.masterWeight !== undefined ||
        op.lowThreshold !== undefined ||
        op.medThreshold !== undefined ||
        op.highThreshold !== undefined
        ? "high"
        : "med";
    case "claimClaimableBalance":
      return "low";
    case "manageData":
    case "changeTrust":
    case "manageSellOffer":
    case "payment":
    case "pathPaymentStrictSend":
      return "med";
    default:
      return "high";
  }
}

/** The weight this transaction needs: its strictest operation, against the account's own
 *  thresholds. A zero threshold still needs one signature. */
export function requiredWeightFor(
  tx: CloseTransaction,
  state: SignerState,
  networkPassphrase: string
): number {
  const parsed = TransactionBuilder.fromXdr(tx.xdr, networkPassphrase);
  if (!(parsed instanceof Transaction)) throw new Error("Unexpected fee-bump envelope.");
  const category = parsed.operations.reduce<ThresholdCategory>((max, op) => {
    const c = thresholdCategory(op);
    return RANK[c] > RANK[max] ? c : max;
  }, "low");
  return Math.max(1, state.thresholds[category]);
}

/** What one ed25519 key contributes, from the account's signer list. */
export function signerWeight(state: SignerState, publicKey: string): number {
  return (
    state.signers.find((s) => s.type === "ed25519_public_key" && s.key === publicKey)?.weight ?? 0
  );
}

/** The server cannot carry an exchange close to this destination right now. Nothing was built,
 *  signed or submitted when this is thrown. */
export class MediatorUnavailableError extends Error {
  constructor(
    readonly destination: string,
    readonly available: boolean,
    readonly registryFresh: boolean
  ) {
    super(
      !available
        ? "The API has no intermediary key for this network, so it cannot co-sign the forward (a self-hosted API needs MEDIATOR_SECRET_TESTNET and MEDIATOR_PUBLIC_TESTNET)."
        : "The API's exchange registry is past its verification window, so it refuses exchange closes."
    );
    this.name = "MediatorUnavailableError";
  }
}

/**
 * The intermediary may only add its signature. Refuses a co-signed envelope whose body differs
 * from the one the user signed (any change to it changes the hash), or that carries no new
 * signature, before anything is submitted.
 */
export function assertCosignOnlyAddedSignature(
  signedXdr: string,
  cosignedXdr: string,
  networkPassphrase: string
): void {
  const before = TransactionBuilder.fromXdr(signedXdr, networkPassphrase);
  const after = TransactionBuilder.fromXdr(cosignedXdr, networkPassphrase);
  if (!(before instanceof Transaction) || !(after instanceof Transaction)) {
    throw new Error("Unexpected fee-bump envelope.");
  }
  const hex = (tx: Transaction): string => Buffer.from(tx.hash()).toString("hex");
  if (hex(after) !== hex(before)) {
    throw new Error("The co-signed transaction does not match the one that was signed.");
  }
  // Distinct signatures, each identified by its hint and signature bytes, so a repeated copy of
  // one already there never counts as the intermediary's.
  const distinct = (tx: Transaction): Set<string> =>
    new Set(tx.signatures.map((sig) => sig.toXDR("base64")));
  const approved = distinct(before);
  const cosigned = distinct(after);
  if (![...approved].every((sig) => cosigned.has(sig))) {
    throw new Error("The co-signed transaction dropped a signature.");
  }
  if (cosigned.size <= approved.size) {
    throw new Error("The intermediary did not add its signature.");
  }
}

/** The fields an operator needs to act on a failure, never only its message. */
export function describeError(error: unknown): string[] {
  const lines: string[] = [];
  if (error instanceof LumenWipeApiError) {
    lines.push(
      `${error.name}: ${error.message}`,
      `  status: ${error.status}`,
      `  code: ${error.code}`
    );
    if (error.requestId) lines.push(`  requestId: ${error.requestId}`);
    if (error.details !== undefined) lines.push(`  details: ${JSON.stringify(error.details)}`);
  } else if (error instanceof InsufficientSignatureWeightError) {
    const { tx, requiredWeight, accumulatedWeight } = error.pending;
    lines.push(
      `${error.name}: transaction ${tx.id} has weight ${accumulatedWeight} of ${requiredWeight}.`
    );
    lines.push("  Sign with another key, then resume with runClose(deps, error.pending).");
  } else if (error instanceof MediatorUnavailableError) {
    lines.push(
      `${error.name}: ${error.message}`,
      `  destination: ${error.destination}`,
      `  available: ${error.available}`,
      `  registryFresh: ${error.registryFresh}`
    );
  } else if (error instanceof Error) {
    lines.push(`${error.name}: ${error.message}`);
  } else {
    lines.push(`Non-error thrown: ${String(error)}`);
  }
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
  if (cause !== undefined) lines.push(...describeError(cause).map((line) => `  cause: ${line}`));
  return lines;
}

interface ProcessLike {
  on(event: "unhandledRejection", listener: (reason: unknown) => void): unknown;
  exitCode?: number | string | null;
}

/** A rejection nobody awaited still fails the run, with the same output as any other error. */
export function installErrorHandlers(
  target: ProcessLike,
  log: (line: string) => void = console.error
): void {
  target.on("unhandledRejection", (reason) => {
    describeError(reason).forEach((line) => log(line));
    target.exitCode = 1;
  });
}

/** Runs an example's entry point: exit code 0 or the one it returns, 1 on any error. An error
 *  exits at once rather than waiting on requests still in flight. */
export function runMain(main: () => Promise<number | void>): void {
  installErrorHandlers(process);
  main().then(
    (code) => {
      process.exitCode = code ?? 0;
    },
    (error: unknown) => {
      describeError(error).forEach((line) => console.error(line));
      process.exit(1);
    }
  );
}

export function requireEnv(name: string, hint: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Set ${name} (${hint}).`);
    process.exit(1);
  }
  return value;
}
