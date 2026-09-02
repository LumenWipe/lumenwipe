import { Address, scValToNative, xdr, type Operation } from "@stellar/stellar-sdk";
import type { IntentOperationBody } from "@/types/close-api";

type Invocation = Extract<IntentOperationBody, { type: "invoke_host_function" }>;

interface Referenced {
  accounts: Set<string>;
  contracts: Set<string>;
  /** Address forms a verifier cannot pin to anything: muxed accounts, claimable balances, pools. */
  unsupported: number;
}

function collectAddress(address: xdr.ScAddress, into: Referenced): void {
  switch (address.switch()) {
    case xdr.ScAddressType.scAddressTypeAccount():
      into.accounts.add(Address.fromScAddress(address).toString());
      return;
    case xdr.ScAddressType.scAddressTypeContract():
      into.contracts.add(Address.fromScAddress(address).toString());
      return;
    default:
      into.unsupported += 1;
  }
}

/** Every address that appears anywhere inside a value, at any depth. */
function collectFromValue(value: xdr.ScVal, into: Referenced): void {
  switch (value.switch()) {
    case xdr.ScValType.scvAddress():
      collectAddress(value.address(), into);
      return;
    case xdr.ScValType.scvVec():
      for (const item of value.vec() ?? []) collectFromValue(item, into);
      return;
    case xdr.ScValType.scvMap():
      for (const entry of value.map() ?? []) {
        collectFromValue(entry.key(), into);
        collectFromValue(entry.val(), into);
      }
      return;
    default:
      return;
  }
}

/**
 * Walks an authorized invocation tree: what the signature will let the contract do on the
 * signer's behalf, including every nested call. Returns false when the tree contains anything
 * other than plain contract calls (creating contracts, for instance), which no close needs.
 */
function collectFromInvocation(node: xdr.SorobanAuthorizedInvocation, into: Referenced): boolean {
  const fn = node.function();
  if (fn.switch() !== xdr.SorobanAuthorizedFunctionType.sorobanAuthorizedFunctionTypeContractFn()) {
    return false;
  }
  const call = fn.contractFn();
  collectAddress(call.contractAddress(), into);
  for (const arg of call.args()) collectFromValue(arg, into);
  let plain = true;
  for (const sub of node.subInvocations()) plain = collectFromInvocation(sub, into) && plain;
  return plain;
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
 * a human would read them, and - the part a verifier holds the line on - every account and
 * contract address the call names anywhere: in its arguments, and in every authorization entry
 * the signature will satisfy, down to the last nested call. A transaction's signature authorizes
 * that whole tree, not just the visible arguments, so the tree is where a hidden transfer would
 * hide. Anything the signature would authorize beyond the signer's own plain contract calls -
 * another party's credentials, a contract creation - is flagged rather than described.
 *
 * Anything other than a plain contract call at the top level (uploading code, creating a
 * contract) is not part of any close and is reported as unknown.
 */
export function describeInvocation(op: Operation.InvokeHostFunction): IntentOperationBody {
  const func = op.func;
  if (func.switch() !== xdr.HostFunctionType.hostFunctionTypeInvokeContract()) {
    return { type: "unknown" };
  }
  const invocation = func.invokeContract();
  const referenced: Referenced = { accounts: new Set(), contracts: new Set(), unsupported: 0 };
  const args = invocation.args();
  for (const arg of args) collectFromValue(arg, referenced);

  let authorizesBeyondSelf = false;
  for (const entry of op.auth ?? []) {
    if (
      entry.credentials().switch() !== xdr.SorobanCredentialsType.sorobanCredentialsSourceAccount()
    ) {
      // Credentials for some other address: the transaction would carry another party's
      // authorization, which a single-account close never needs.
      authorizesBeyondSelf = true;
    }
    if (!collectFromInvocation(entry.rootInvocation(), referenced)) authorizesBeyondSelf = true;
  }

  const described: Invocation = {
    type: "invoke_host_function",
    contract: Address.fromScAddress(invocation.contractAddress()).toString(),
    function: invocation.functionName().toString(),
    args: args.map(render),
    accountsReferenced: [...referenced.accounts].sort(),
    contractsReferenced: [...referenced.contracts].sort(),
    unsupportedAddressCount: referenced.unsupported,
    authorizesBeyondSelf,
  };
  return described;
}
