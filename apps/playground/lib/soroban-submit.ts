import "server-only";
import {
  Account,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  rpc,
  TransactionBuilder,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import { loadHorizonAccount, SOROBAN_RPC_TESTNET_URL } from "./horizon-submit";

// Playground Soroban submission (testnet only), for the seeding a protocol exit scenario needs.
//
// The sequence comes from Horizon, like every classic submission here (lib/horizon-submit.ts),
// because the load-balanced RPC can read a stale one. The RPC is trusted for nothing it returns:
// its simulation decides the resource fee and the authorization entries the demo key will sign
// for, so before signing the assembled transaction is held to the call that was built. The host
// function must be byte-equal to it, every authorization entry must be satisfied by the
// transaction's own signature and be rooted at that same call, and the total fee is capped.

export class SorobanSubmitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SorobanSubmitError";
  }
}

/**
 * The most a seeding transaction may pay, in stroops: the cap the shared verifier puts on a DeFi
 * exit (`MAX_EXIT_FEE_STROOPS` in apps/web/lib/stellar/verify.ts), restated rather than imported.
 */
export const MAX_SOROBAN_FEE_STROOPS = BigInt(10_000_000);

const TX_TIMEOUT_SECONDS = 60;
const SEND_ATTEMPTS = 3;
const SEND_RETRY_MS = 2_000;
const POLL_INTERVAL_MS = 1_000;
const POLL_TIMEOUT_MS = 60_000;

type SorobanRpc = Pick<rpc.Server, "simulateTransaction" | "sendTransaction" | "getTransaction">;

export interface SorobanSubmitDeps {
  loadSequence: (address: string) => Promise<string>;
  rpc: SorobanRpc;
  /** The SDK's assembly; injectable so a test can stand in for one that changes the call. */
  assemble: (tx: Transaction, sim: rpc.Api.SimulateTransactionResponse) => Transaction;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const defaultDeps = (): SorobanSubmitDeps => ({
  loadSequence: async (address) => (await loadHorizonAccount(address)).sequenceNumber(),
  rpc: new rpc.Server(SOROBAN_RPC_TESTNET_URL),
  assemble: (tx, sim) => rpc.assembleTransaction(tx, sim).build(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
});

/** The one contract call a Soroban transaction makes, as its operation. */
function invocationOf(tx: Transaction): Operation.InvokeHostFunction {
  const op = tx.operations.length === 1 ? tx.operations[0] : undefined;
  if (op?.type !== "invokeHostFunction") throw new SorobanSubmitError("not_one_contract_call");
  return op;
}

/**
 * Refuses an assembled transaction the simulation changed beyond its fee and footprint: run
 * before signing, so the demo key never signs what the RPC added.
 */
export function assertAssembledMatches(
  assembled: Transaction,
  built: xdr.HostFunction,
  source: string
): void {
  const op = invocationOf(assembled);
  if (op.func.toXdr("base64") !== built.toXdr("base64")) {
    throw new SorobanSubmitError("assembled_host_function_changed");
  }
  if ((op.source ?? assembled.source) !== source) {
    throw new SorobanSubmitError("assembled_source_changed");
  }
  if (built.type !== "hostFunctionTypeInvokeContract") {
    throw new SorobanSubmitError("host_function_not_contract_call");
  }
  const call = xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
    built.invokeContract
  ).toXdr("base64");
  for (const entry of op.auth ?? []) {
    if (entry.credentials.type !== "sorobanCredentialsSourceAccount") {
      throw new SorobanSubmitError("auth_credentials_not_source");
    }
    if (entry.rootInvocation.function.toXdr("base64") !== call) {
      throw new SorobanSubmitError("auth_root_not_the_call");
    }
  }
  if (BigInt(assembled.fee) > MAX_SOROBAN_FEE_STROOPS) {
    throw new SorobanSubmitError("fee_above_cap");
  }
}

async function waitForResult(hash: string, deps: SorobanSubmitDeps): Promise<{ txHash: string }> {
  const deadline = deps.now() + POLL_TIMEOUT_MS;
  while (deps.now() < deadline) {
    const res = await deps.rpc.getTransaction(hash);
    if (res.status === rpc.Api.GetTransactionStatus.SUCCESS) return { txHash: hash };
    if (res.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw new SorobanSubmitError(`transaction_failed: ${hash}`);
    }
    await deps.sleep(POLL_INTERVAL_MS);
  }
  throw new SorobanSubmitError(`transaction_timeout: ${hash}`);
}

/** Simulate, check, sign with `source`, send and wait for one contract call's transaction. */
export async function submitSoroban(
  source: Keypair,
  op: xdr.Operation,
  overrides: Partial<SorobanSubmitDeps> = {}
): Promise<{ txHash: string }> {
  const deps = { ...defaultDeps(), ...overrides };
  const address = source.publicKey();
  const sequence = await deps.loadSequence(address);
  const tx = new TransactionBuilder(new Account(address, sequence), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(op)
    .setTimeout(TX_TIMEOUT_SECONDS)
    .build();
  const built = invocationOf(tx).func;

  const sim = await deps.rpc.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new SorobanSubmitError(`simulation_failed: ${sim.error}`);
  }
  if (rpc.Api.isSimulationRestore(sim)) {
    throw new SorobanSubmitError("simulation_needs_restore");
  }
  const assembled = deps.assemble(tx, sim);
  assertAssembledMatches(assembled, built, address);
  assembled.sign(source);

  for (let attempt = 1; ; attempt++) {
    const sent = await deps.rpc.sendTransaction(assembled);
    if (sent.status === "PENDING" || sent.status === "DUPLICATE") {
      return waitForResult(sent.hash, deps);
    }
    if (sent.status === "ERROR") {
      const code = sent.errorResult?.result.type ?? "unknown";
      throw new SorobanSubmitError(`send_rejected: ${code}`);
    }
    if (attempt >= SEND_ATTEMPTS) throw new SorobanSubmitError("send_try_again_later");
    await deps.sleep(SEND_RETRY_MS * attempt);
  }
}
