import { xdr, type Transaction } from "@stellar/stellar-sdk";

export function v1Transaction(tx: Transaction): xdr.Transaction {
  return v1TransactionOf(tx.toEnvelope());
}

export function v1TransactionOf(envelope: xdr.TransactionEnvelope): xdr.Transaction {
  if (envelope.type !== "envelopeTypeTx") throw new Error("not a v1 envelope");
  return envelope.v1.tx;
}

export function v1TransactionFromXdr(txXdr: string): xdr.Transaction {
  return v1TransactionOf(xdr.TransactionEnvelope.fromXdr(txXdr, "base64"));
}

export function invokeContractArgs(op: xdr.Operation): xdr.InvokeContractArgs {
  if (op.body.type !== "invokeHostFunction") throw new Error("not an invoke host function op");
  const host = op.body.invokeHostFunctionOp.hostFunction;
  if (host.type !== "hostFunctionTypeInvokeContract") throw new Error("not a contract call");
  return host.invokeContract;
}
