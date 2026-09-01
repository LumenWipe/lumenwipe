// Must stay the first import, exactly as in src/main.ts - see sponsorship.integration.test.ts
// for the full rationale (config/networks.ts reads process.env at import time).
import "@/env";
import { test, expect } from "bun:test";
import {
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import { getAccountState } from "@/lib/stellar/account-state";
import { buildCloseTransactions } from "@/lib/close-api/build-transactions";
import type { AccountState } from "@lumenwipe/types";

const FRIENDBOT = "https://friendbot.stellar.org";
const HORIZON_URL = "https://horizon-testnet.stellar.org";
const RUN_INTEGRATION = !!process.env.LUMENWIPE_RUN_INTEGRATION;

// The public Soroban RPC testnet endpoint is a different provider from the Horizon-compatible
// one configureTx below is confirmed against, and is load-balanced across nodes that lag each
// other and lag Horizon (see the same phenomenon documented in sponsorship.integration.test.ts
// and src/config/constants.ts's ACCOUNT_VISIBILITY_* comment). buildCloseTransactions reads the
// account's live sequence number from RPC (build-transactions.ts:89-91), so if RPC hasn't yet
// ingested the just-submitted SetOptions transaction that configures the 2-of-3, it could build
// against a stale sequence number - a spurious tx_bad_seq unrelated to the security property
// this test actually proves. ~20s of total patience observed sufficient during manual testnet
// runs of the same lag on the sponsorship path.
const ACCOUNT_STATE_POLL_MAX_ATTEMPTS = 8;
const ACCOUNT_STATE_POLL_DELAY_MS = 2500;

async function fund(publicKey: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT}?addr=${publicKey}`);
  if (!res.ok) throw new Error(`friendbot funding failed for ${publicKey}: ${res.status}`);
}

async function accountExists(server: Horizon.Server, id: string): Promise<boolean> {
  try {
    await server.loadAccount(id);
    return true;
  } catch {
    return false;
  }
}

// Horizon's submitTransaction rejects with an axios-style error carrying the actual result
// codes at response.data.extras.result_codes. Narrowed with a type guard (no `any`, per this
// repo's conventions) so the one-signer-submission assertion below can confirm the rejection
// is genuinely an authorization failure - transaction-level "tx_failed" with an "op_bad_auth"
// operation code, confirmed empirically against real testnet - not merely "some rejection
// happened" (a network blip, bad sequence, etc. would carry different codes entirely).
function transactionResultCodes(
  err: unknown
): { transaction: string; operations: string[] } | undefined {
  if (typeof err !== "object" || err === null || !("response" in err)) return undefined;
  const response = (err as { response?: unknown }).response;
  if (typeof response !== "object" || response === null || !("data" in response)) return undefined;
  const data = (response as { data?: unknown }).data;
  if (typeof data !== "object" || data === null || !("extras" in data)) return undefined;
  const extras = (data as { extras?: unknown }).extras;
  if (typeof extras !== "object" || extras === null || !("result_codes" in extras))
    return undefined;
  const resultCodes = (extras as { result_codes?: unknown }).result_codes;
  if (
    typeof resultCodes !== "object" ||
    resultCodes === null ||
    !("transaction" in resultCodes) ||
    !("operations" in resultCodes)
  ) {
    return undefined;
  }
  const { transaction, operations } = resultCodes as { transaction: unknown; operations: unknown };
  if (typeof transaction !== "string" || !Array.isArray(operations)) return undefined;
  if (!operations.every((op) => typeof op === "string")) return undefined;
  return { transaction, operations: operations as string[] };
}

// Retries getAccountState until it reflects the just-submitted 2-of-3 SetOptions
// configuration (all 3 signers present), or the attempt cap is hit, absorbing Soroban RPC's
// ingestion lag relative to the Horizon-compatible endpoint the configuring transaction was
// confirmed against. Also retries through a transient AccountNotFoundError, matching
// readAccountStateUntilSponsoring's rationale in sponsorship.integration.test.ts.
async function readAccountStateUntilSignersConfigured(publicKey: string): Promise<AccountState> {
  let lastState: AccountState | null = null;
  let lastError: unknown;
  for (let attempt = 0; attempt < ACCOUNT_STATE_POLL_MAX_ATTEMPTS; attempt++) {
    try {
      lastState = await getAccountState(publicKey, "testnet");
      if (lastState.signers.length === 3) return lastState;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, ACCOUNT_STATE_POLL_DELAY_MS));
  }
  // Out of attempts: return the last successful read (if any) so the assertions below
  // report the real mismatch, rather than masking it behind a retry error.
  if (lastState) return lastState;
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

test.skipIf(!RUN_INTEGRATION)(
  "a real 2-of-3 multisig account is closed end to end: one signer alone is rejected, two meet threshold and merge",
  async () => {
    const server = new Horizon.Server(HORIZON_URL);
    const master = Keypair.random(); // the account being closed - also signer #1
    const coSignerB = Keypair.random(); // signer #2
    const coSignerC = Keypair.random(); // signer #3, deliberately never used

    const destination = Keypair.random();

    await Promise.all([fund(master.publicKey()), fund(destination.publicKey())]);

    // Configure into 2-of-3: add two co-signers at weight 1 each, then raise every
    // threshold category to 2 so ACCOUNT_MERGE (a high-threshold op) genuinely needs two
    // of the three weight-1 keys - matches the epic's "2-of-3" acceptance criterion.
    const masterAccount = await server.loadAccount(master.publicKey());
    const configureTx = new TransactionBuilder(masterAccount, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.setOptions({ signer: { ed25519PublicKey: coSignerB.publicKey(), weight: 1 } })
      )
      .addOperation(
        Operation.setOptions({ signer: { ed25519PublicKey: coSignerC.publicKey(), weight: 1 } })
      )
      .addOperation(Operation.setOptions({ lowThreshold: 1, medThreshold: 2, highThreshold: 2 }))
      .setTimeout(60)
      .build();
    configureTx.sign(master);
    await server.submitTransaction(configureTx);

    // This is the function under test: confirms account-state reading surfaces the real
    // multisig signer set and thresholds this close will need to satisfy. Polls rather than
    // reading once immediately, since RPC (the provider buildCloseTransactions reads from
    // below) can lag Horizon's already-confirmed configureTx by several seconds.
    const accountState = await readAccountStateUntilSignersConfigured(master.publicKey());
    expect(accountState.signers).toHaveLength(3);
    expect(accountState.thresholds).toEqual({ low: 1, med: 2, high: 2 });

    // This is the function under test: builds the real close transaction(s) against live
    // state. A fresh account with no subentries/balances beyond XLM closes as a single
    // fused merge transaction.
    const result = await buildCloseTransactions(
      accountState,
      destination.publicKey(),
      {},
      "testnet",
      null,
      {}
    );
    expect(result.transactions).toHaveLength(1);
    expect(result.requiresAnotherCall).toBe(false);
    const unsignedXdr = result.transactions[0].xdr;

    // One signer alone (weight 1) must NOT meet the high threshold (2) - proves this is a
    // genuine 2-of-3 account on-chain, not accidentally satisfiable by one key.
    const oneSigTx = TransactionBuilder.fromXDR(unsignedXdr, Networks.TESTNET);
    oneSigTx.sign(master);
    let oneSigError: unknown;
    try {
      await server.submitTransaction(oneSigTx);
    } catch (err) {
      oneSigError = err;
    }
    expect(oneSigError).toBeDefined();
    // Specifically an authorization failure, not just "any rejection" - confirms the
    // account genuinely required two signatures rather than failing for an unrelated
    // reason (bad sequence, network blip, etc).
    const codes = transactionResultCodes(oneSigError);
    expect(codes?.transaction).toBe("tx_failed");
    expect(codes?.operations).toContain("op_bad_auth");
    expect(await accountExists(server, master.publicKey())).toBe(true);

    // A second signer (co-signer B) brings accumulated weight to 2, meeting the threshold -
    // submit succeeds and the account is gone (merged).
    const twoSigTx = TransactionBuilder.fromXDR(unsignedXdr, Networks.TESTNET);
    twoSigTx.sign(master);
    twoSigTx.sign(coSignerB);
    const submitResult = await server.submitTransaction(twoSigTx);
    expect(submitResult.successful).toBe(true);

    expect(await accountExists(server, master.publicKey())).toBe(false);
  },
  90000
);
