import { TransactionBuilder, type rpc, xdr } from "@stellar/stellar-sdk";
import { getRpcServer, nextRpcServer } from "./rpc";
import {
  translateRpcError,
  TxPendingError,
  TxSubmitError,
  TxUnsettledError,
  InvalidXdrError,
  extractResultCode,
} from "@/lib/utils/errors";
import { checkTransactionSignatures, InvalidSignatureError } from "@/lib/stellar/signature";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import type { Network } from "@/config/networks";
import {
  POLL_INTERVAL_MS,
  RPC_READ_TIMEOUT_MS,
  SETTLE_WINDOW_MS,
  SUBMIT_BUDGET_MS,
} from "@/config/constants";
import { withTimeout } from "@/lib/utils/with-timeout";

// How many times to retry a TRY_AGAIN_LATER response before surfacing the error.
// The status is transient (node is under load) and typically resolves in seconds.
const TRY_AGAIN_MAX_RETRIES = 3;
const TRY_AGAIN_DELAY_MS = 4_000;

// What a node answers for a transaction that already landed somewhere it has not caught up with.
// Testnet, 2026-11-02: a confirmed merge re-sent answers tx_no_account and a confirmed payment
// tx_bad_seq, and both answer TRY_AGAIN_LATER for the first half minute. A fee-bump reports its
// inner failure as one code, so the inner reason cannot be read from it.
const MAY_ALREADY_HAVE_LANDED: ReadonlySet<string> = new Set([
  "tx_bad_seq",
  "tx_no_account",
  "tx_too_late",
  "tx_fee_bump_inner_failed",
]);

export interface SubmitResult {
  txHash: string;
  ledger: number;
}

export interface SubmitClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const realClock: SubmitClock = {
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

type Verdict = rpc.Api.GetSuccessfulTransactionResponse | rpc.Api.GetFailedTransactionResponse;

interface HashCheck {
  txHash: string;
  server: rpc.Server;
  clock: SubmitClock;
  /** When the whole submit has to have answered. */
  until: number;
}

export async function submitAndWait(
  signedXdr: string,
  network: Network,
  onStatus?: (status: string) => void,
  serverFor: (network: Network) => rpc.Server = getRpcServer,
  nextServerFor: (network: Network) => rpc.Server | null = nextRpcServer,
  clock: SubmitClock = realClock
): Promise<SubmitResult> {
  const until = clock.now() + SUBMIT_BUDGET_MS;
  const server = serverFor(network);
  const passphrase = NETWORK_PASSPHRASES[network];

  let tx;
  try {
    tx = TransactionBuilder.fromXDR(signedXdr, passphrase);
  } catch {
    throw new InvalidXdrError();
  }

  // Offline pre-flight: catch missing/invalid signatures before wasting a round-trip
  checkTransactionSignatures(tx);

  onStatus?.("Submitting to Stellar network...");

  const txHash = Buffer.from(tx.hash()).toString("hex");
  const check: HashCheck = { txHash, server, clock, until };

  // A prior call may have submitted this exact transaction and it confirmed, but the
  // caller never saw the response (network drop, client timeout). By the time a retry
  // arrives, the network's own sendTransaction dedup window (DUPLICATE) may have closed,
  // so resubmitting would surface a stale-sequence rejection instead of the success that
  // already happened. Check history first - if it already confirmed, report that instead
  // of resubmitting (docs/architecture.md §22).
  const priorResult = await server.getTransaction(txHash);
  if (priorResult.status === "SUCCESS") {
    onStatus?.("Already confirmed.");
    return { txHash, ledger: priorResult.ledger };
  }
  if (priorResult.status === "FAILED") throw rejectedBy(priorResult.resultXdr);

  // The send is bounded by the RPC client's own timeout and is never raced: abandoning it would
  // leave a transaction that may still land. Nothing below starts a send that could outlive the
  // budget, so a retry after TRY_AGAIN_LATER waits only while a full read timeout still fits.
  let sendResult: Awaited<ReturnType<typeof server.sendTransaction>>;
  let tryAgainCount = 0;
  while (true) {
    try {
      sendResult = await server.sendTransaction(tx);
    } catch (e) {
      const failure = e instanceof Error ? e : new Error(String(e));
      return settledOrThrow(await settleByHash(check, nextServerFor(network)), txHash, () => {
        throw new TxUnsettledError(txHash, failure.message);
      });
    }

    if (sendResult.status !== "TRY_AGAIN_LATER") break;

    const nextSendAt = clock.now() + TRY_AGAIN_DELAY_MS;
    if (++tryAgainCount >= TRY_AGAIN_MAX_RETRIES || nextSendAt + RPC_READ_TIMEOUT_MS > until) {
      return settledOrThrow(await settleByHash(check, nextServerFor(network)), txHash, () => {
        throw new TxUnsettledError(
          txHash,
          "The network is congested and could not accept the transaction. Please retry in a moment."
        );
      });
    }

    onStatus?.(`Network busy, retrying (${tryAgainCount}/${TRY_AGAIN_MAX_RETRIES})…`);
    await clock.sleep(TRY_AGAIN_DELAY_MS);
  }

  if (sendResult.status === "ERROR") {
    const raw = sendResult.errorResult != null ? sendResult.errorResult.toXDR("base64") : "";
    const code = extractResultCode(raw);
    const rejection = new TxSubmitError(translateRpcError("ERROR", raw), code);
    if (code === null || !MAY_ALREADY_HAVE_LANDED.has(code)) throw rejection;
    return settledOrThrow(await settleByHash(check, nextServerFor(network)), txHash, () => {
      throw rejection;
    });
  }

  // DUPLICATE means the transaction was already submitted - treat as success and poll.
  onStatus?.("Waiting for ledger confirmation...");

  return settledOrThrow(await pollByHash(check, until), txHash, () => {
    throw new TxPendingError(txHash);
  });
}

function settledOrThrow(
  verdict: Verdict | null,
  txHash: string,
  noVerdict: () => never
): SubmitResult {
  if (!verdict) noVerdict();
  if (verdict.status === "FAILED") throw rejectedBy(verdict.resultXdr);
  return { txHash, ledger: verdict.ledger };
}

/**
 * Asks for the transaction until `stopAt`, always at least once. A read that fails says nothing
 * about the transaction, so it only costs its turn: the question stays open until the budget ends.
 */
async function pollByHash(check: HashCheck, stopAt: number): Promise<Verdict | null> {
  const { txHash, server, clock } = check;
  while (true) {
    const seen = await readVerdict(server, txHash, Math.max(stopAt - clock.now(), 1_000));
    if (seen) return seen;
    if (clock.now() + POLL_INTERVAL_MS >= stopAt) return null;
    await clock.sleep(POLL_INTERVAL_MS);
  }
}

async function readVerdict(
  server: rpc.Server,
  txHash: string,
  capMs: number
): Promise<Verdict | null> {
  try {
    const seen = await withTimeout(
      server.getTransaction(txHash),
      Math.min(capMs, RPC_READ_TIMEOUT_MS),
      "by-hash read timed out"
    );
    return seen.status === "NOT_FOUND" ? null : seen;
  } catch {
    return null;
  }
}

/**
 * An answer short of acceptance may still have reached the network, and sending again elsewhere is
 * how a transaction lands twice or a stale sequence hides a success. So the follow-up is reading
 * by hash for a couple of ledgers, then one look at another provider. Null means no verdict.
 */
async function settleByHash(check: HashCheck, next: rpc.Server | null): Promise<Verdict | null> {
  const { txHash, clock, until } = check;
  const seen = await pollByHash(check, Math.min(until, clock.now() + SETTLE_WINDOW_MS));
  if (seen || !next) return seen;
  return readVerdict(next, txHash, Math.max(until - clock.now(), 1_000));
}

function rejectedBy(resultXdr: unknown): TxSubmitError {
  const raw = serializeResultXdr(resultXdr);
  return new TxSubmitError(translateRpcError("FAILED", raw), extractResultCode(raw));
}

export function serializeResultXdr(resultXdr: unknown): string {
  if (!resultXdr) return "";
  if (typeof resultXdr === "string") return resultXdr;
  try {
    return (resultXdr as xdr.TransactionResult).toXDR("base64");
  } catch {
    return "";
  }
}

// Re-export so callers can distinguish signature errors from network errors
export { InvalidSignatureError };
