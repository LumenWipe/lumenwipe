import type {
  AccountState,
  AssetDisposition,
  CloseTransaction,
  Network,
  TransferDestinations,
} from "@lumenwipe/types";
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
import { NETWORK_PASSPHRASES } from "@/config/networks";
import { intentFromXdr } from "@/lib/stellar/intent/serialize";

/**
 * The Soroban token round (architecture.md §10, #161): one transaction per token the user chose
 * to transfer as-is, `token.transfer(account, destination, balance)`, built here and simulated
 * against the current ledger like every Soroban step. Runs after the exit round (an exit can pay
 * a token out) and before the classic close; the client submits, waits, and calls again, and the
 * next round finds the balance gone.
 *
 * This is not an exit adapter: the token is the user's own arbitrary contract, so it can never be
 * vouched for by the registry the exit runner gates on. What holds the line instead is the shape
 * of the call, checked here after simulation and again by the web anchor before signing: exactly
 * one operation, `transfer` on the chosen token with the account, the chosen destination, and the
 * live balance as its three arguments, and an authorization tree of plain single calls - every
 * entry under the account's own credentials, none with a nested call. A token whose `transfer`
 * asks the account to authorize anything else is refused by name, never signed.
 *
 * Tokens the user chose to leave need no transaction: a Soroban balance is contract data, not an
 * account subentry, so the merge proceeds with it in place.
 */

/** A token whose transfer cannot be built safely; the close builder turns it into its 422. */
export class TokenTransferBlockedError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "TokenTransferBlockedError";
  }
}

export interface TokenTransferRoundDeps {
  rpc: Pick<stellarRpc.Server, "simulateTransaction">;
}

export interface TokenTransferRound {
  transaction: CloseTransaction;
  /** Token transfers still to build after this one. */
  remainingSteps: number;
}

const CONTRACT_ID = /^C[A-Z2-7]{55}$/;

function shortContract(contract: string): string {
  return `${contract.slice(0, 4)}…${contract.slice(-4)}`;
}

function describeToken(accountState: AccountState, contract: string): string {
  const token = accountState.sorobanTokens?.tokens.find((t) => t.contract === contract);
  return token?.symbol ?? shortContract(contract);
}

async function simulate(
  rpc: TokenTransferRoundDeps["rpc"],
  tx: Transaction
): Promise<stellarRpc.Api.SimulateTransactionResponse> {
  const response = await rpc.simulateTransaction(tx);
  return stellarRpc.Api.isSimulationRaw(response)
    ? stellarRpc.parseRawSimulation(response)
    : response;
}

/** The account's live balance of the token, by simulating `balance(account)`; null if unreadable. */
async function liveBalance(
  rpc: TokenTransferRoundDeps["rpc"],
  network: Network,
  account: string,
  token: string
): Promise<bigint | null> {
  const tx = new TransactionBuilder(new Account(account, "0"), {
    fee: String(BASE_FEE_STROOPS),
    networkPassphrase: NETWORK_PASSPHRASES[network],
  })
    .addOperation(new Contract(token).call("balance", new Address(account).toScVal()))
    .setTimeout(30)
    .build();
  const simulation = await simulate(rpc, tx);
  if (!stellarRpc.Api.isSimulationSuccess(simulation) || !simulation.result) return null;
  const native: unknown = scValToNative(simulation.result.retval);
  if (typeof native === "bigint") return native;
  if (typeof native === "number" && Number.isInteger(native)) return BigInt(native);
  return null;
}

/**
 * Refuses an assembled transfer whose shape is anything other than the one plain call the user
 * asked for. Everything here is re-checked by the web anchor; a mismatch is a bug in this round or
 * a token behaving in a way no transfer should, and either must stop before a signature.
 */
export function assertPlainTransfer(
  tx: Transaction,
  expected: { token: string; from: string; to: string; amount: bigint }
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
  if (call.functionName().toString() !== "transfer") throw new Error("the call is not transfer");
  const args = call.args();
  if (args.length !== 3) throw new Error(`transfer takes three arguments, found ${args.length}`);
  const [from, to, amount] = args;
  if (Address.fromScVal(from!).toString() !== expected.from)
    throw new Error("from is not the account");
  if (Address.fromScVal(to!).toString() !== expected.to)
    throw new Error("to is not the destination");
  const amountNative: unknown = scValToNative(amount!);
  if (typeof amountNative !== "bigint" || amountNative !== expected.amount) {
    throw new Error("the amount is not the live balance");
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
      authorized.functionName().toString() !== "transfer"
    ) {
      throw new Error("an authorization entry authorizes a call other than this transfer");
    }
  }
  if (BigInt(tx.fee) > BigInt(MAX_SOROBAN_EXIT_FEE_STROOPS)) {
    throw new Error("the fee exceeds what a token transfer can need");
  }
}

/**
 * Builds the next token transfer, or null when no held token is due to be transferred. A token
 * that cannot be read or whose transfer the ledger refuses stops the build by name: the user
 * chose to keep that balance, and every alternative would lose it.
 */
export async function buildTokenTransferRound(
  accountState: AccountState,
  dispositions: Record<string, AssetDisposition>,
  transferDestinations: TransferDestinations,
  network: Network,
  sequence: string,
  validUntilLedger: number,
  deps: TokenTransferRoundDeps
): Promise<TokenTransferRound | null> {
  const due = (accountState.sorobanTokens?.tokens ?? [])
    .map((t) => t.contract)
    .filter((c) => CONTRACT_ID.test(c) && dispositions[c] === "transfer")
    .sort();
  if (due.length === 0) return null;
  const passphrase = NETWORK_PASSPHRASES[network];
  const account = accountState.address;

  for (let i = 0; i < due.length; i++) {
    const token = due[i]!;
    const name = describeToken(accountState, token);
    const destination = transferDestinations[token];
    if (!destination) {
      throw new TokenTransferBlockedError(
        "transfer_destination_missing",
        `Transferring the ${name} balance needs the account to send it to.`
      );
    }
    const balance = await liveBalance(deps.rpc, network, account, token);
    if (balance === null) {
      throw new TokenTransferBlockedError(
        "soroban_token_unreadable",
        `The ${name} token (${shortContract(token)}) would not report this account's balance, ` +
          "so its transfer cannot be built. Retry the analysis; if it persists, move the balance " +
          "through the token's own interface before continuing."
      );
    }
    // Already moved (a previous round confirmed): nothing left here, look at the next token.
    if (balance <= 0n) continue;

    const raw = new TransactionBuilder(new Account(account, sequence), {
      fee: String(BASE_FEE_STROOPS),
      networkPassphrase: passphrase,
    })
      .addOperation(
        new Contract(token).call(
          "transfer",
          new Address(account).toScVal(),
          new Address(destination).toScVal(),
          nativeToScVal(balance, { type: "i128" })
        )
      )
      .setTimeout(TX_TIMEOUT_SECONDS)
      .build();
    const simulation = await simulate(deps.rpc, raw);
    if (stellarRpc.Api.isSimulationRestore(simulation)) {
      throw new TokenTransferBlockedError(
        "soroban_token_needs_restore",
        `The ${name} token's ledger entries are archived and must be restored before its balance ` +
          "can move. Restore them through the token's own interface, then retry."
      );
    }
    if (!stellarRpc.Api.isSimulationSuccess(simulation)) {
      throw new TokenTransferBlockedError(
        "soroban_token_transfer_failed",
        `The network refused a transfer of the ${name} balance to ${destination.slice(0, 4)}…` +
          `${destination.slice(-4)} when simulated. The token may restrict who can receive it; ` +
          "choose another destination or leave the balance on record."
      );
    }
    let signable: Transaction;
    try {
      signable = stellarRpc.assembleTransaction(raw, simulation).build();
      assertPlainTransfer(signable, { token, from: account, to: destination, amount: balance });
    } catch (err) {
      throw new TokenTransferBlockedError(
        "soroban_token_transfer_unsafe",
        `The ${name} token's transfer could not be offered for signing: ` +
          `${err instanceof Error ? err.message : String(err)}. Move this balance through the ` +
          "token's own interface, or leave it on record."
      );
    }
    const xdrBase64 = signable.toXDR();
    return {
      transaction: {
        id: "tx-1",
        order: 0,
        dependsOn: [],
        xdr: xdrBase64,
        networkPassphrase: passphrase,
        sourceSequence: sequence,
        validUntilLedger,
        covers: ["HANDLE_ASSETS"],
        intent: {
          ...intentFromXdr(xdrBase64, passphrase),
          summary: `Send ${balance} base units of ${name} to ${destination.slice(0, 4)}…${destination.slice(-4)}`,
        },
      },
      remainingSteps: due.length - i - 1,
    };
  }
  return null;
}
