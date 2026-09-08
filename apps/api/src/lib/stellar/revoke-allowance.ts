import {
  Account,
  Address,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  rpc as stellarRpc,
  scValToNative,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import {
  BASE_FEE_STROOPS,
  MAX_SOROBAN_EXIT_FEE_STROOPS,
  TX_TIMEOUT_SECONDS,
} from "@/config/constants";
import { NETWORK_PASSPHRASES, type Network } from "@/config/networks";

/**
 * The allowance inspector's revocation side (architecture.md §12, #163): a standalone
 * transaction, entirely outside the account-close flow, that sets a SEP-41 allowance to zero
 * with `approve(owner, spender, 0, expiration_ledger)` - one `InvokeHostFunction` operation.
 * Structurally the same "build, simulate, assemble, assert the shape before offering it for
 * signing" pattern as token-transfer-round.ts's `transfer`, adapted for `approve`'s four
 * arguments and its zero-amount case (no destination to check; the second and third arguments
 * are what a revoke is actually about).
 */

/** A revocation whose shape cannot be built or offered safely; the endpoint turns it into its
 *  own error response rather than ever handing back an unsafe transaction. */
export class RevokeAllowanceBlockedError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "RevokeAllowanceBlockedError";
  }
}

export interface RevokeAllowanceDeps {
  rpc: Pick<stellarRpc.Server, "simulateTransaction" | "getAccount">;
}

async function simulate(
  rpc: RevokeAllowanceDeps["rpc"],
  tx: Transaction
): Promise<stellarRpc.Api.SimulateTransactionResponse> {
  const response = await rpc.simulateTransaction(tx);
  return stellarRpc.Api.isSimulationRaw(response)
    ? stellarRpc.parseRawSimulation(response)
    : response;
}

/**
 * Refuses an assembled revocation whose shape is anything other than the one plain call it must
 * be. Everything here is re-checked by the web anchor before signing; a mismatch is a bug in this
 * builder or a token behaving in a way no revocation should, and either must stop before a
 * signature - never something a caller can talk this endpoint into signing on their behalf.
 */
export function assertPlainRevoke(
  tx: Transaction,
  expected: { token: string; owner: string; spender: string }
): void {
  const ops = tx.toEnvelope().v1().tx().operations();
  if (ops.length !== 1) throw new Error(`expected one operation, found ${ops.length}`);
  const op = ops[0]!;
  if (op.body().switch() !== xdr.OperationType.invokeHostFunction()) {
    throw new Error("the operation is not a contract invocation");
  }
  const host = op.body().invokeHostFunctionOp();
  const fn = host.hostFunction();
  if (fn.switch() !== xdr.HostFunctionType.hostFunctionTypeInvokeContract()) {
    throw new Error("the invocation is not a contract call");
  }
  const call = fn.invokeContract();
  if (Address.fromScAddress(call.contractAddress()).toString() !== expected.token) {
    throw new Error("the call targets a different contract");
  }
  if (call.functionName().toString() !== "approve") throw new Error("the call is not approve");
  const args = call.args();
  if (args.length !== 4) throw new Error(`approve takes four arguments, found ${args.length}`);
  const [from, spender, amount] = args;
  if (Address.fromScVal(from!).toString() !== expected.owner) {
    throw new Error("from is not the account");
  }
  if (Address.fromScVal(spender!).toString() !== expected.spender) {
    throw new Error("spender is not the one being revoked");
  }
  const amountNative: unknown = scValToNative(amount!);
  if (typeof amountNative !== "bigint" || amountNative !== 0n) {
    throw new Error("the amount is not zero - this is not a revocation");
  }
  if (host.auth().length === 0) {
    throw new Error("the simulation produced no authorization for the revocation");
  }
  for (const entry of host.auth()) {
    if (
      entry.credentials().switch() !== xdr.SorobanCredentialsType.sorobanCredentialsSourceAccount()
    ) {
      throw new Error("an authorization entry carries credentials other than the account's own");
    }
    const root = entry.rootInvocation();
    if (root.subInvocations().length > 0) {
      throw new Error("the token asks the account to authorize a nested call");
    }
    const rootFn = root.function();
    if (
      rootFn.switch() !==
      xdr.SorobanAuthorizedFunctionType.sorobanAuthorizedFunctionTypeContractFn()
    ) {
      throw new Error("an authorization entry is not a plain contract call");
    }
    const authorized = rootFn.contractFn();
    if (
      Address.fromScAddress(authorized.contractAddress()).toString() !== expected.token ||
      authorized.functionName().toString() !== "approve"
    ) {
      throw new Error("an authorization entry authorizes a call other than this revocation");
    }
    const authorizedArgs = authorized.args();
    if (
      authorizedArgs.length !== 4 ||
      Address.fromScVal(authorizedArgs[0]!).toString() !== expected.owner ||
      Address.fromScVal(authorizedArgs[1]!).toString() !== expected.spender ||
      scValToNative(authorizedArgs[2]!) !== 0n
    ) {
      throw new Error("an authorization entry authorizes an approve call with different arguments");
    }
  }
  if (BigInt(tx.fee) > BigInt(MAX_SOROBAN_EXIT_FEE_STROOPS)) {
    throw new Error("the fee exceeds what a revocation can need");
  }
}

export interface RevokeAllowanceTransaction {
  xdr: string;
  networkPassphrase: string;
  sourceSequence: string;
  summary: string;
}

/**
 * Builds the one-operation `approve(owner, spender, 0, 0)` transaction that revokes a live
 * allowance. The expiration ledger is 0: it has no meaning once the amount is zero, and the
 * contract does not validate it against the current ledger in that case, unlike a genuine grant.
 */
export async function buildRevokeAllowanceTransaction(
  owner: string,
  token: string,
  spender: string,
  network: Network,
  deps: RevokeAllowanceDeps
): Promise<RevokeAllowanceTransaction> {
  const passphrase = NETWORK_PASSPHRASES[network];
  const liveAccount = await deps.rpc.getAccount(owner);
  const raw = new TransactionBuilder(new Account(owner, liveAccount.sequenceNumber()), {
    fee: String(BASE_FEE_STROOPS),
    networkPassphrase: passphrase,
  })
    .addOperation(
      new Contract(token).call(
        "approve",
        new Address(owner).toScVal(),
        new Address(spender).toScVal(),
        nativeToScVal(0n, { type: "i128" }),
        nativeToScVal(0, { type: "u32" })
      )
    )
    .setTimeout(TX_TIMEOUT_SECONDS)
    .build();

  const simulation = await simulate(deps.rpc, raw);
  if (stellarRpc.Api.isSimulationRestore(simulation)) {
    throw new RevokeAllowanceBlockedError(
      "revoke_needs_restore",
      "This token's ledger entries are archived and must be restored before the allowance can " +
        "be revoked. Restore them through the token's own interface, then retry."
    );
  }
  if (!stellarRpc.Api.isSimulationSuccess(simulation)) {
    throw new RevokeAllowanceBlockedError(
      "revoke_simulation_failed",
      "The network refused this revocation when simulated. The token or spender contract may no " +
        "longer exist, or the allowance may already be gone."
    );
  }

  let signable: Transaction;
  try {
    signable = stellarRpc.assembleTransaction(raw, simulation).build();
    assertPlainRevoke(signable, { token, owner, spender });
  } catch (err) {
    throw new RevokeAllowanceBlockedError(
      "revoke_unsafe",
      `This revocation could not be offered for signing: ` +
        `${err instanceof Error ? err.message : String(err)}.`
    );
  }

  const xdrBase64 = signable.toXDR();
  return {
    xdr: xdrBase64,
    networkPassphrase: passphrase,
    sourceSequence: liveAccount.sequenceNumber(),
    summary: `Revoke the allowance for ${spender.slice(0, 4)}…${spender.slice(-4)} on ${token.slice(0, 4)}…${token.slice(-4)}`,
  };
}
