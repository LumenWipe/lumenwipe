import { Address, scValToNative, xdr, type Operation } from "@stellar/stellar-sdk";
import type { IntentOperationBody, SubInvocationCall } from "@/types/close-api";

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
 * Every call is also recorded into `subInvocations`, except the one node that is genuinely the
 * operation's own top-level call, already described elsewhere by `contract`/`function`/`args`.
 *
 * `op.auth` can carry more than one entry for the same source-account credentials, each rooted
 * wherever that address's authorization was actually required in the real call graph - not
 * necessarily at the operation's own invoked function. A hostile build can leave the legitimate
 * top-level call untouched and add a second, independent entry rooted directly at, say, a held
 * token's `transfer` - that root would never reach `subInvocations` if every entry's root were
 * unconditionally treated as "the same call already described elsewhere." So `isEntryRoot` alone
 * is not enough: only a root that also matches `topLevel`'s own contract and function is the
 * genuine top-level call; any other entry's root is a sub-invocation just like a nested call,
 * and only a node's own direct entry-root position - never a deeper descendant - is even a
 * candidate for that exemption.
 */
function collectFromInvocation(
  node: xdr.SorobanAuthorizedInvocation,
  into: Referenced,
  subInvocations: SubInvocationCall[],
  topLevel: { contract: string; function: string },
  isEntryRoot: boolean
): boolean {
  const fn = node.function();
  if (fn.switch() !== xdr.SorobanAuthorizedFunctionType.sorobanAuthorizedFunctionTypeContractFn()) {
    return false;
  }
  const call = fn.contractFn();
  const contract = Address.fromScAddress(call.contractAddress()).toString();
  const functionName = call.functionName().toString();
  collectAddress(call.contractAddress(), into);
  for (const arg of call.args()) collectFromValue(arg, into);
  const isTopLevelCall =
    isEntryRoot && contract === topLevel.contract && functionName === topLevel.function;
  if (!isTopLevelCall) {
    subInvocations.push({ contract, function: functionName, args: call.args().map(render) });
  }
  let plain = true;
  for (const sub of node.subInvocations()) {
    plain = collectFromInvocation(sub, into, subInvocations, topLevel, false) && plain;
  }
  return plain;
}

/** How many levels of nested calls an authorized invocation carries: 0 for a lone call. */
function invocationDepth(node: xdr.SorobanAuthorizedInvocation): number {
  let deepest = 0;
  for (const sub of node.subInvocations()) deepest = Math.max(deepest, 1 + invocationDepth(sub));
  return deepest;
}

function render(value: xdr.ScVal): string {
  try {
    const native: unknown = scValToNative(value);
    // Plain text for the two shapes a verifier compares on: an address, and an integer amount.
    if (typeof native === "string") return native;
    if (typeof native === "bigint" || typeof native === "number") return native.toString();
    return JSON.stringify(native, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
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
  const topLevel = {
    contract: Address.fromScAddress(invocation.contractAddress()).toString(),
    function: invocation.functionName().toString(),
  };

  let authorizesBeyondSelf = false;
  let authDepth = 0;
  const subInvocations: SubInvocationCall[] = [];
  for (const entry of op.auth ?? []) {
    authDepth = Math.max(authDepth, invocationDepth(entry.rootInvocation()));
    if (
      entry.credentials().switch() !== xdr.SorobanCredentialsType.sorobanCredentialsSourceAccount()
    ) {
      // Credentials for some other address: the transaction would carry another party's
      // authorization, which a single-account close never needs.
      authorizesBeyondSelf = true;
    }
    if (
      !collectFromInvocation(entry.rootInvocation(), referenced, subInvocations, topLevel, true)
    ) {
      authorizesBeyondSelf = true;
    }
  }

  const described: Invocation = {
    type: "invoke_host_function",
    contract: topLevel.contract,
    function: topLevel.function,
    args: args.map(render),
    accountsReferenced: [...referenced.accounts].sort(),
    contractsReferenced: [...referenced.contracts].sort(),
    unsupportedAddressCount: referenced.unsupported,
    subInvocations,
    authorizesBeyondSelf,
    authDepth,
  };
  return described;
}
