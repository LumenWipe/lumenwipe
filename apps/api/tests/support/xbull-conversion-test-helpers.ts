/**
 * Shared test fixtures for the xBull conversion suite: builds a one-operation
 * invokeHostFunction transaction around a real (or hand-crafted) `InvokeContractArgs` XDR, the
 * same shape `apps/api/tests/unit/token-conversion-round.test.ts`'s own `swapTx()` builds for
 * Soroswap - a synthetic `SorobanAuthorizationEntry` whose root invocation is exactly that call,
 * authorized by the account's own source credentials. Exported (not left local to one test file)
 * so both the shape-assertion suite (Task 4) and the adversarial suite (Task 9) build their
 * fixtures from the one real captured `contractArgsXDR`, never a hand-typed approximation of it.
 */
import {
  Account,
  Address,
  Contract,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";

export interface AssembleOptions {
  fee?: string;
  maxTime?: number;
  /** When set, the assembled transaction's single authorization entry carries this
   *  one-level `subInvocations` entry (a token `transfer(from, to, amount)` call) nested
   *  under the `strict_send` root, instead of the default empty `subInvocations: []`. */
  subInvocation?: TransferSubInvocation;
}

export interface TransferSubInvocation {
  token: string;
  from: string;
  to: string;
  amount: string;
}

/**
 * Builds a `SorobanAuthorizedInvocation` for `token.transfer(from, to, amount)`, the shape a
 * `strict_send` route's own root invocation nests one level below itself to pull the input
 * amount from the account before routing it through pools. Used only via `AssembleOptions.
 * subInvocation` to exercise `walkXBullAuth`, which otherwise has no test coverage at all since
 * `assembleTestTransaction` always builds `subInvocations: []` by default.
 */
function transferSubInvocation(sub: TransferSubInvocation): xdr.SorobanAuthorizedInvocation {
  const call = new xdr.InvokeContractArgs({
    contractAddress: new Address(sub.token).toScAddress(),
    functionName: "transfer",
    args: [
      new Address(sub.from).toScVal(),
      new Address(sub.to).toScVal(),
      nativeToScVal(BigInt(sub.amount), { type: "i128" }),
    ],
  });
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(call),
    subInvocations: [],
  });
}

/**
 * Wraps `contractArgsXDR` (base64 `InvokeContractArgs`) in a full, signable transaction from
 * `source` at `sequence`, with one `invokeHostFunction` operation and a matching
 * source-account-credentialed authorization entry over the same call - mirroring exactly what
 * `buildXBullConversion` assembles in production, minus the RPC simulation step.
 */
export function assembleTestTransaction(
  contractArgsXDR: string,
  source: string,
  sequence: string,
  opts: AssembleOptions = {}
): Transaction {
  const contractArgs = xdr.InvokeContractArgs.fromXDR(contractArgsXDR, "base64");
  const contract = Address.fromScAddress(contractArgs.contractAddress()).toString();
  const root = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(contractArgs),
    subInvocations: opts.subInvocation ? [transferSubInvocation(opts.subInvocation)] : [],
  });
  const auth = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: root,
  });
  const op = new Contract(contract).call(
    contractArgs.functionName().toString(),
    ...contractArgs.args()
  );
  // Contract.call() carries no auth of its own; rebuild the operation with the entry attached,
  // the same round-trip token-conversion-round.test.ts's swapTx() uses.
  const withAuth = xdr.Operation.fromXDR(op.toXDR());
  withAuth.body().invokeHostFunctionOp().auth([auth]);
  return new TransactionBuilder(new Account(source, sequence), {
    fee: opts.fee ?? "52485",
    networkPassphrase: Networks.PUBLIC,
  })
    .addOperation(withAuth)
    .setTimebounds(0, opts.maxTime ?? 1_700_000_000 + 3600)
    .build();
}

/**
 * Re-encodes a captured `contractArgsXDR`, replacing exactly one of `strict_send`'s six
 * arguments (`from`, `to`, `amount`, `min_to_get`, `path`, `refs`, by index 0-5) with `value`,
 * leaving every other argument untouched. Used to build narrowly-targeted tests that trip one
 * specific argument-level check in `assertXBullConversionShape` without also disturbing the
 * transaction-level checks (source, sequence) or any other argument.
 */
export function reencodeSwapArg(contractArgsXDR: string, index: number, value: xdr.ScVal): string {
  const contractArgs = xdr.InvokeContractArgs.fromXDR(contractArgsXDR, "base64");
  const args = [...contractArgs.args()];
  if (index < 0 || index >= args.length) {
    throw new Error(`arg index ${index} out of range (0-${args.length - 1})`);
  }
  args[index] = value;
  const rebuilt = new xdr.InvokeContractArgs({
    contractAddress: contractArgs.contractAddress(),
    functionName: contractArgs.functionName(),
    args,
  });
  return rebuilt.toXDR("base64");
}

/**
 * Re-encodes a captured `contractArgsXDR`, replacing its `refs` argument (the 6th, always empty
 * in a genuine LumenWipe-built call) with a non-empty vector of `(address, amount)` tuples - the
 * shape a referral fee would take. Used only to prove `assertXBullConversionShape` refuses a
 * non-empty `refs`; the exact tuple encoding does not matter to that check, only that it is a
 * non-empty `ScVec`.
 */
export function reencodeWithRefs(contractArgsXDR: string, refs: Array<[string, string]>): string {
  const contractArgs = xdr.InvokeContractArgs.fromXDR(contractArgsXDR, "base64");
  const args = contractArgs.args();
  if (args.length !== 6) throw new Error(`expected 6 args, found ${args.length}`);
  const refsVec = xdr.ScVal.scvVec(
    refs.map(([address, amount]) =>
      xdr.ScVal.scvVec([
        new Address(address).toScVal(),
        nativeToScVal(BigInt(amount), { type: "i128" }),
      ])
    )
  );
  const rebuilt = new xdr.InvokeContractArgs({
    contractAddress: contractArgs.contractAddress(),
    functionName: contractArgs.functionName(),
    args: [...args.slice(0, 5), refsVec],
  });
  return rebuilt.toXDR("base64");
}
