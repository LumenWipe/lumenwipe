import { Address, type Transaction, type xdr } from "@stellar/stellar-sdk";

export function envelopeOps(tx: Transaction): xdr.Operation[] {
  const envelope = tx.toEnvelope();
  if (envelope.type !== "envelopeTypeTx") throw new Error("the transaction is not a v1 envelope");
  return envelope.v1.tx.operations;
}

export function invokedContract(tx: Transaction): string {
  const body = envelopeOps(tx)[0]?.body;
  if (body?.type !== "invokeHostFunction") throw new Error("the operation is not a contract call");
  const fn = body.invokeHostFunctionOp.hostFunction;
  if (fn.type !== "hostFunctionTypeInvokeContract")
    throw new Error("the call is not a contract call");
  return Address.fromScAddress(fn.invokeContract.contractAddress).toString();
}
