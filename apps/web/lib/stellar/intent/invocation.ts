import { Address, scValToNative, xdr, type Operation } from "@stellar/stellar-sdk";
import type { IntentOperationBody } from "@/types/close-api";

type Invocation = Extract<IntentOperationBody, { type: "invoke_host_function" }>;

/** Every Stellar account address (G...) that appears anywhere inside a value, at any depth. */
function collectAccounts(value: xdr.ScVal, into: Set<string>): void {
  switch (value.switch()) {
    case xdr.ScValType.scvAddress(): {
      const address = value.address();
      if (address.switch() === xdr.ScAddressType.scAddressTypeAccount()) {
        into.add(Address.fromScAddress(address).toString());
      }
      return;
    }
    case xdr.ScValType.scvVec():
      for (const item of value.vec() ?? []) collectAccounts(item, into);
      return;
    case xdr.ScValType.scvMap():
      for (const entry of value.map() ?? []) {
        collectAccounts(entry.key(), into);
        collectAccounts(entry.val(), into);
      }
      return;
    default:
      return;
  }
}

function render(value: xdr.ScVal): string {
  try {
    const native: unknown = scValToNative(value);
    return typeof native === "string"
      ? native
      : JSON.stringify(native, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
  } catch {
    return value.toXDR("base64");
  }
}

/**
 * Describes a contract invocation for the intent: which contract and function, the arguments as
 * a human would read them, and every account address the arguments name - the one field a
 * verifier can hold to "only the account being closed" without knowing the protocol's ABI.
 * Anything other than a plain contract call (uploading code, creating a contract) is not part of
 * any close and is reported as unknown.
 */
export function describeInvocation(op: Operation.InvokeHostFunction): IntentOperationBody {
  const func = op.func;
  if (func.switch() !== xdr.HostFunctionType.hostFunctionTypeInvokeContract()) {
    return { type: "unknown" };
  }
  const invocation = func.invokeContract();
  const accounts = new Set<string>();
  const args = invocation.args();
  for (const arg of args) collectAccounts(arg, accounts);
  const described: Invocation = {
    type: "invoke_host_function",
    contract: Address.fromScAddress(invocation.contractAddress()).toString(),
    function: invocation.functionName().toString(),
    args: args.map(render),
    accountsReferenced: [...accounts].sort(),
  };
  return described;
}
