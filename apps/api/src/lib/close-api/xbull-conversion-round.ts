import {
  Account,
  Address,
  Operation,
  TransactionBuilder,
  rpc as stellarRpc,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import type { Network } from "@lumenwipe/types";
import { MAX_SOROBAN_EXIT_FEE_STROOPS } from "@/config/constants";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import { addressOf, bigOf, collectAccounts, CONTRACT_ID } from "@/lib/stellar/scval-read";
import { fetchXBullSwapArgs, type XBullConversionDeps } from "@/lib/xbull/conversion-quotes";

/**
 * The xBull PathPayment router's `strict_send` shape (spec §5.4): `(from, to, amount,
 * min_to_get, path, refs)`. Unlike Soroswap's router/aggregator shapes, `path` carries indices
 * into the contract's own on-chain asset map, not addresses inline - so the caller must supply
 * `resolvedPath`, the same index-to-address resolution `buildXBullConversion` (below) reads
 * live from the contract's storage immediately before building, re-read here rather than
 * inferred, per the hard invariant against building or verifying from stale data.
 */
export const XBULL_SWAP_FUNCTION = "strict_send";
const SIGNING_BUFFER_SECONDS = 60n;

export interface ExpectedXBullConversion {
  token: string;
  account: string;
  xlm: string;
  amountIn: bigint;
  minOut: bigint;
  /** The live-resolved chain of asset addresses `path`'s indices name, first to last hop. */
  resolvedPath: string[];
  allowed: { router: string[] };
  sequence: string;
  nowSeconds: number;
}

export function assertXBullConversionShape(tx: Transaction, expected: ExpectedXBullConversion): void {
  if (tx.source !== expected.account) throw new Error("the transaction is not this account's");
  if (tx.sequence !== (BigInt(expected.sequence) + 1n).toString()) {
    throw new Error("the transaction is not this account's next transaction");
  }
  if (tx.memo.type !== "none") throw new Error("the swap carries a memo");
  if (BigInt(tx.fee) > BigInt(MAX_SOROBAN_EXIT_FEE_STROOPS)) {
    throw new Error("the fee exceeds what a swap can need");
  }
  const maxTime = tx.timeBounds ? BigInt(tx.timeBounds.maxTime) : 0n;
  if (maxTime === 0n || maxTime < BigInt(expected.nowSeconds) + SIGNING_BUFFER_SECONDS) {
    throw new Error("the swap never expires, or expires before it can be signed");
  }
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
  const contract = Address.fromScAddress(call.contractAddress()).toString();
  if (!expected.allowed.router.includes(contract)) {
    throw new Error(`the swap is not a call on xBull's registered router (${contract})`);
  }
  if (call.functionName().toString() !== XBULL_SWAP_FUNCTION) {
    throw new Error(`the call is ${call.functionName().toString()}, not ${XBULL_SWAP_FUNCTION}`);
  }
  const args = call.args();
  if (args.length !== 6) throw new Error(`strict_send takes 6 arguments, found ${args.length}`);
  const [from, to, amount, minToGet, path, refs] = args;
  if (addressOf(from!) !== expected.account) throw new Error("the swap does not spend this account's balance");
  if (addressOf(to!) !== expected.account) throw new Error("the swap does not pay this account");
  if (bigOf(amount!) !== expected.amountIn) throw new Error("amount is not the live balance");
  const min = bigOf(minToGet!);
  if (min === null || min < expected.minOut) throw new Error("min_to_get is below your floor");
  if (refs!.switch() !== xdr.ScValType.scvVec() || (refs!.vec() ?? []).length !== 0) {
    throw new Error("the swap would pay a referral fee to an address you never agreed to");
  }
  if (path!.switch() !== xdr.ScValType.scvVec()) throw new Error("path is not a list");
  const hopCount = (path!.vec() ?? []).length;
  if (hopCount === 0 || hopCount !== expected.resolvedPath.length - 1) {
    // resolvedPath names every asset the route touches, so it has one more entry than the
    // number of hops between them; a mismatch means the resolution the caller supplied is
    // stale against the path actually being signed.
    throw new Error("the resolved route does not match this transaction's path");
  }
  if (expected.resolvedPath[0] !== expected.token || expected.resolvedPath.at(-1) !== expected.xlm) {
    throw new Error("the route does not go from this token to XLM");
  }
  if (expected.resolvedPath.some((hop) => !CONTRACT_ID.test(hop))) {
    throw new Error("the route names something that is not a token contract");
  }

  if (host.auth().length === 0) throw new Error("the build produced no authorization for the swap");
  for (const auth of host.auth()) {
    if (auth.credentials().switch() !== xdr.SorobanCredentialsType.sorobanCredentialsSourceAccount()) {
      throw new Error("an authorization entry carries credentials other than the account's own");
    }
    const root = auth.rootInvocation();
    const rootFn = root.function();
    if (rootFn.switch() !== xdr.SorobanAuthorizedFunctionType.sorobanAuthorizedFunctionTypeContractFn()) {
      throw new Error("an authorization entry is not a plain contract call");
    }
    const rootCall = rootFn.contractFn();
    if (
      Address.fromScAddress(rootCall.contractAddress()).toString() !== contract ||
      rootCall.functionName().toString() !== XBULL_SWAP_FUNCTION
    ) {
      throw new Error("an authorization entry authorizes a call other than this swap");
    }
    for (const arg of rootCall.args()) collectAccounts(arg, expected.account);
    for (const sub of root.subInvocations()) walkXBullAuth(sub, expected);
  }
}

/** The token's own `transfer` is the only sub-invocation a `strict_send` route needs; anything
 *  else nested under it is refused, the same closed-world rule Soroswap's own walk applies. */
function walkXBullAuth(node: xdr.SorobanAuthorizedInvocation, expected: ExpectedXBullConversion): void {
  const fn = node.function();
  if (fn.switch() !== xdr.SorobanAuthorizedFunctionType.sorobanAuthorizedFunctionTypeContractFn()) {
    throw new Error("the signature would authorize something other than a contract call");
  }
  const call = fn.contractFn();
  const contract = Address.fromScAddress(call.contractAddress()).toString();
  if (contract !== expected.token) {
    throw new Error(`the signature would authorize a call on ${contract}, which no swap needs`);
  }
  if (call.functionName().toString() !== "transfer") {
    throw new Error(`the signature would authorize ${call.functionName().toString()} on the token`);
  }
  for (const arg of call.args()) collectAccounts(arg, expected.account);
  for (const sub of node.subInvocations()) walkXBullAuth(sub, expected);
}

export interface XBullBuildDeps {
  rpc: Pick<stellarRpc.Server, "simulateTransaction">;
  xbull: XBullConversionDeps;
  /** Reads the router's live Map storage and resolves `path`'s indices to asset addresses,
   *  first hop to last. Implemented in Task 4's follow-up (contract-storage read); a caller
   *  supplies a stub here and the real implementation in production wiring (Task 7). */
  resolvePath: (contractArgsXDR: string) => Promise<string[]>;
}

/**
 * Builds and simulates the actual invokeHostFunction transaction for an xBull swap, against
 * LumenWipe's own configured RPC - never xBull's suggested one, and never the npm kit's own
 * local assembly. Returns null on any failure; the caller decides what that means for the
 * round (spec §3: this is a strictly better fit for "re-read exact on-chain state right before
 * building" than accepting a fully pre-built transaction from a third party).
 */
export async function buildXBullConversion(
  quote: { token: string; route: string; amountIn: string; minAmountOut: string },
  from: string,
  network: Network,
  sequence: string,
  deps: XBullBuildDeps
): Promise<{ xdr: string; contractArgsXDR: string } | null> {
  const contractArgsXDR = await fetchXBullSwapArgs(
    quote.route,
    from,
    BigInt(quote.amountIn),
    BigInt(quote.minAmountOut),
    deps.xbull
  );
  if (!contractArgsXDR) return null;
  try {
    const contractArgs = xdr.InvokeContractArgs.fromXDR(contractArgsXDR, "base64");
    const account = new Account(from, sequence);
    const tx = new TransactionBuilder(account, {
      fee: MAX_SOROBAN_EXIT_FEE_STROOPS.toString(),
      networkPassphrase: NETWORK_PASSPHRASES[network],
    })
      .addOperation(
        Operation.invokeHostFunction({
          func: xdr.HostFunction.hostFunctionTypeInvokeContract(contractArgs),
        })
      )
      .setTimeout(180)
      .build();
    const sim = await deps.rpc.simulateTransaction(tx);
    if (stellarRpc.Api.isSimulationError(sim)) return null;
    const assembled = stellarRpc.assembleTransaction(tx, sim).build();
    return { xdr: assembled.toXDR(), contractArgsXDR };
  } catch {
    return null;
  }
}
