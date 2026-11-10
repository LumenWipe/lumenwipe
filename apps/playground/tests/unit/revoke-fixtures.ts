import {
  Account,
  Address,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import { XLM_SAC } from "@/lib/scenarios";

// A revoke as apps/api/src/lib/stellar/revoke-allowance.ts builds it once the RPC has assembled
// it: one `approve(owner, spender, 0, 0)` on the token, authorized by the owner's own source
// account, valid for 300 seconds, with each part replaceable so a test can break one at a time.

export interface RevokeTxOpts {
  owner: string;
  spender: string;
  source?: string;
  opSource?: string;
  contract?: string;
  fn?: string;
  from?: string;
  amount?: xdr.ScVal;
  args?: xdr.ScVal[];
  /** Replaces the authorization entries; by default one, rooted at the call. */
  auth?: (call: xdr.InvokeContractArgs) => xdr.SorobanAuthorizationEntry[];
  fee?: string;
  /** Seconds the transaction stays valid; 0 builds one with no upper time bound. */
  timeout?: number;
  extraOps?: xdr.Operation[];
}

/** The same transaction carrying a text memo: the SDK's builder refuses one on a Soroban
 *  transaction, but an envelope from the API could still hold one. */
export function withMemo(tx: Transaction, text: string): Transaction {
  const envelope = tx.toEnvelope();
  if (envelope.type !== "envelopeTypeTx") throw new Error("expected a v1 envelope");
  const memoed = xdr.TransactionEnvelope.envelopeTypeTx(
    new xdr.TransactionV1Envelope({
      tx: new xdr.Transaction({ ...envelope.v1.tx, memo: xdr.Memo.memoText(text) }),
      signatures: [],
    })
  );
  const parsed = TransactionBuilder.fromXDR(memoed.toXDR("base64"), Networks.TESTNET);
  if (!(parsed instanceof Transaction)) throw new Error("expected a transaction");
  return parsed;
}

export const address = (a: string): xdr.ScVal => new Address(a).toScVal();

export function approveArgs(
  owner: string,
  spender: string,
  amount: xdr.ScVal = nativeToScVal(BigInt(0), { type: "i128" })
): xdr.ScVal[] {
  return [address(owner), address(spender), amount, xdr.ScVal.scvU32(0)];
}

export const rootedAt = (
  call: xdr.InvokeContractArgs,
  subInvocations: xdr.SorobanAuthorizedInvocation[] = [],
  credentials: xdr.SorobanCredentials = xdr.SorobanCredentials.sorobanCredentialsSourceAccount()
): xdr.SorobanAuthorizationEntry =>
  new xdr.SorobanAuthorizationEntry({
    credentials,
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(call),
      subInvocations,
    }),
  });

export function revokeTx(opts: RevokeTxOpts): Transaction {
  const contract = opts.contract ?? XLM_SAC;
  const fn = opts.fn ?? "approve";
  const args = opts.args ?? approveArgs(opts.from ?? opts.owner, opts.spender, opts.amount);
  const call = new xdr.InvokeContractArgs({
    contractAddress: new Address(contract).toScAddress(),
    functionName: fn,
    args,
  });
  const builder = new TransactionBuilder(new Account(opts.source ?? opts.owner, "41"), {
    fee: opts.fee ?? "61234",
    networkPassphrase: Networks.TESTNET,
  }).addOperation(
    Operation.invokeContractFunction({
      contract,
      function: fn,
      args,
      auth: opts.auth ? opts.auth(call) : [rootedAt(call)],
      ...(opts.opSource && { source: opts.opSource }),
    })
  );
  for (const op of opts.extraOps ?? []) builder.addOperation(op);
  return builder.setTimeout(opts.timeout ?? 300).build();
}
