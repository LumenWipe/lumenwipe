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
    subInvocations: [],
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
