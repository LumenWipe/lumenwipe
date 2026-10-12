import { xdr, type Transaction } from "@stellar/stellar-sdk";

export function onlyOperation(tx: Transaction): xdr.Operation {
  const envelope = tx.toEnvelope();
  if (envelope.type !== "envelopeTypeTx") throw new Error("not a v1 envelope");
  return envelope.v1.tx.operations[0]!;
}

export function invokeOf(op: xdr.Operation): xdr.InvokeHostFunctionOp {
  if (op.body.type !== "invokeHostFunction") throw new Error("not an invokeHostFunction operation");
  return op.body.invokeHostFunctionOp;
}

export function callOf(op: xdr.Operation): xdr.InvokeContractArgs {
  const fn = invokeOf(op).hostFunction;
  if (fn.type !== "hostFunctionTypeInvokeContract") throw new Error("not a contract call");
  return fn.invokeContract;
}

export function withAuth(op: xdr.Operation, auth: xdr.SorobanAuthorizationEntry[]): xdr.Operation {
  const host = invokeOf(op);
  return new xdr.Operation({
    sourceAccount: op.sourceAccount,
    body: xdr.OperationBody.invokeHostFunction(
      new xdr.InvokeHostFunctionOp({ hostFunction: host.hostFunction, auth })
    ),
  });
}

export function withCallArgs(op: xdr.Operation, args: xdr.ScVal[]): xdr.Operation {
  const host = invokeOf(op);
  const call = callOf(op);
  return new xdr.Operation({
    sourceAccount: op.sourceAccount,
    body: xdr.OperationBody.invokeHostFunction(
      new xdr.InvokeHostFunctionOp({
        hostFunction: xdr.HostFunction.hostFunctionTypeInvokeContract(
          new xdr.InvokeContractArgs({
            contractAddress: call.contractAddress,
            functionName: call.functionName,
            args,
          })
        ),
        auth: host.auth,
      })
    ),
  });
}

export function envelopeWithOperations(
  tx: Transaction,
  operations: xdr.Operation[]
): xdr.TransactionEnvelope {
  const envelope = tx.toEnvelope();
  if (envelope.type !== "envelopeTypeTx") throw new Error("not a v1 envelope");
  const inner = envelope.v1.tx;
  return xdr.TransactionEnvelope.envelopeTypeTx(
    new xdr.TransactionV1Envelope({
      tx: new xdr.Transaction({
        sourceAccount: inner.sourceAccount,
        fee: inner.fee,
        seqNum: inner.seqNum,
        cond: inner.cond,
        memo: inner.memo,
        operations,
        ext: inner.ext,
      }),
      signatures: envelope.v1.signatures,
    })
  );
}

export function memoText(tx: Pick<Transaction, "memo">): string | undefined {
  const value = tx.memo.value;
  return value instanceof Uint8Array ? Buffer.from(value).toString("utf8") : value?.toString();
}
