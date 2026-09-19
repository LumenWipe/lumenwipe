import type { AccountState, AssetDisposition, CloseTransaction, Network } from "@lumenwipe/types";
import {
  Address,
  Contract,
  TransactionBuilder,
  rpc as stellarRpc,
  scValToNative,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import { MAX_SOROBAN_EXIT_FEE_STROOPS } from "@/config/constants";
import { NETWORK_PASSPHRASES } from "@/config/networks";
import {
  resolveWasmHash,
  soroswapConversionContracts,
  xbullConversionContracts,
} from "@/lib/contract-registry";
import { readLiveWasmHash } from "@/lib/stellar/contract-instance";
import { intentFromXdr } from "@/lib/stellar/intent/serialize";
import {
  buildTokenConversion,
  defaultConversionDeps,
  quoteTokenToXlm,
  xlmContractId,
  type ConversionDeps,
} from "@/lib/soroswap/conversion-quotes";
import { CONTRACT_ID, addressOf, bigOf, collectAccounts } from "@/lib/stellar/scval-read";
import { formatTokenAmount } from "@/lib/utils/token-amounts";
import { stroopsToXlm } from "@/lib/utils/amounts";
import { TokenTransferBlockedError, liveTokenBalance } from "./token-transfer-round";
import {
  assertXBullConversionShape,
  buildXBullConversion,
  type XBullBuildDeps,
} from "./xbull-conversion-round";
import { defaultXBullConversionDeps, quoteTokenToXlmViaXBull } from "@/lib/xbull/conversion-quotes";

/**
 * The Soroban token conversion round (#161): one transaction per token the user chose to convert,
 * quoted and built through the Soroswap API against the live balance, then decoded and held to
 * the shape a swap must have before it is offered to sign. Runs after the token transfers and
 * before anything classic, one token per round like the exits.
 *
 * Trust here is by structure, not by source. The API builds the bytes; this module refuses them
 * unless: the transaction is the account's own next transaction with no memo and one operation;
 * that operation is `swap_exact_tokens_for_tokens` on the registry's Soroswap aggregator or
 * router, confirmed by the contract's live code hash and not just its address; the arguments
 * spend exactly the live balance of the chosen token, deliver XLM to the account itself, and set
 * a minimum no lower than the floor the user was shown; and the authorization tree the signature
 * satisfies invokes nothing but the aggregator, its adapters, the router, and the token - every
 * `transfer` of the token from the account, none to a Stellar account. The browser re-checks the
 * same shape from the user's own inputs before signing (architecture.md §10.1).
 *
 * `quote_drifted` is the market moving against the user between plan and build: the fresh quote's
 * floor falls under the one they agreed to, so the build stops and asks for a fresh decision
 * rather than swapping at a rate nobody accepted.
 */

export interface TokenConversionRoundDeps {
  rpc: Pick<stellarRpc.Server, "simulateTransaction" | "getLedgerEntries">;
  conversion: ConversionDeps;
  /** Everything an xBull build needs: its own RPC view, its HTTP deps, and the live path
   *  resolver (`resolveXBullPath` below, by default). A sibling of `conversion` above - one
   *  provider's worth of build dependencies per field, never mixed. */
  xbull: XBullBuildDeps;
  /** Which contracts a conversion may invoke on this network; the registry's, by default. */
  allowed: (network: Network) => { aggregator: string[]; adapters: string[]; routers: string[] };
  /** Which router xBull may invoke on this network; the registry's, by default. */
  xbullAllowed: (network: Network) => { router: string[] };
}

export interface TokenConversionRound {
  transaction: CloseTransaction;
  remainingSteps: number;
}

export const SWAP_FUNCTION = "swap_exact_tokens_for_tokens";
/** Aggregator -> adapter -> router -> token.transfer is the deepest tree a route needs. */
const MAX_AUTH_DEPTH = 4;
/** Applied to every expiry a swap carries - the transaction's own timeBounds and the contract-level
 *  `deadline` argument alike - so a swap offered for signing has room to actually be signed. */
const SIGNING_BUFFER_SECONDS = 60n;

export function defaultTokenConversionRoundDeps(
  rpc: TokenConversionRoundDeps["rpc"]
): TokenConversionRoundDeps {
  return {
    rpc,
    conversion: defaultConversionDeps(),
    xbull: {
      rpc,
      xbull: defaultXBullConversionDeps(),
      resolvePath: (contractArgsXDR) => resolveXBullPath(rpc, contractArgsXDR),
    },
    allowed: soroswapConversionContracts,
    xbullAllowed: xbullConversionContracts,
  };
}

/**
 * Resolves xBull's `path` argument's opaque indices to the asset addresses they name, by
 * reading the router's own `Map(u32)` persistent storage entries live - never cached, never
 * inferred from the quote - the same "re-read exact on-chain state right before building" rule
 * every other exit already follows. Confirmed field order (Task 1, cross-referenced from two
 * independent live mainnet sources: the contract's own Map(u32) storage and 15 real
 * `strict_send` events, including multi-hop self-consistency checks): `(u32, u32, u32, u32)` =
 * `[protocol_id, in_asset_index, pool_id, out_asset_index]`. `IN_INDEX_POSITION` and
 * `OUT_INDEX_POSITION` below are that confirmed order, not a guess - see
 * `apps/api/tests/fixtures/xbull-strict-send-sample.json`'s own `pathTupleOrder` field, captured
 * from the same research.
 */
async function resolveXBullPath(
  rpc: Pick<stellarRpc.Server, "getLedgerEntries">,
  contractArgsXDR: string
): Promise<string[]> {
  const contractArgs = xdr.InvokeContractArgs.fromXDR(contractArgsXDR, "base64");
  const args = contractArgs.args();
  const pathArg = args[4]!;
  const tuples = scValToNative(pathArg) as number[][];
  const contract = new Contract(Address.fromScAddress(contractArgs.contractAddress()).toString());
  const IN_INDEX_POSITION = 1;
  const OUT_INDEX_POSITION = 3;
  const indices = new Set<number>();
  for (let i = 0; i < tuples.length; i++) {
    const hop = tuples[i]!;
    if (i > 0 && hop[IN_INDEX_POSITION] !== tuples[i - 1]![OUT_INDEX_POSITION]) {
      throw new Error(`xBull's path is disconnected: hop ${i} does not continue from hop ${i - 1}`);
    }
    indices.add(hop[IN_INDEX_POSITION]!);
    indices.add(hop[OUT_INDEX_POSITION]!);
  }
  const resolved = new Map<number, string>();
  for (const index of indices) {
    const key = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Map"), xdr.ScVal.scvU32(index)]);
    const entries = await rpc.getLedgerEntries(
      xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: contract.address().toScAddress(),
          key,
          durability: xdr.ContractDataDurability.persistent(),
        })
      )
    );
    const entry = entries.entries?.[0];
    if (!entry) throw new Error(`xBull's asset map has no entry for index ${index}`);
    resolved.set(index, scValToNative(entry.val.contractData().val()) as string);
  }
  return tuples.flatMap((hop, i) =>
    i === 0
      ? [resolved.get(hop[IN_INDEX_POSITION]!)!, resolved.get(hop[OUT_INDEX_POSITION]!)!]
      : [resolved.get(hop[OUT_INDEX_POSITION]!)!]
  );
}

function short(id: string): string {
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

export interface ExpectedConversion {
  token: string;
  account: string;
  xlm: string;
  amountIn: bigint;
  /** The least XLM the swap may deliver: the user's floor. */
  minOut: bigint;
  allowed: { aggregator: string[]; adapters: string[]; routers: string[] };
  /** The account's sequence number before this transaction. */
  sequence: string;
  nowSeconds: number;
}

/** The swap call's own arguments, in either shape the API builds. */
function assertSwapArgs(args: xdr.ScVal[], expected: ExpectedConversion): void {
  if (args.length === 5) {
    // Router: (amount_in, amount_out_min, path, to, deadline).
    const [amountIn, minOut, path, to, deadline] = args;
    if (bigOf(amountIn!) !== expected.amountIn)
      throw new Error("amount_in is not the live balance");
    const min = bigOf(minOut!);
    if (min === null || min < expected.minOut)
      throw new Error("amount_out_min is below your floor");
    if (path!.switch() !== xdr.ScValType.scvVec()) throw new Error("path is not a list");
    const hops = (path!.vec() ?? []).map(addressOf);
    if (hops.length < 2 || hops[0] !== expected.token || hops[hops.length - 1] !== expected.xlm) {
      throw new Error("the route does not go from this token to XLM");
    }
    if (hops.some((h) => h === null || !CONTRACT_ID.test(h))) {
      throw new Error("the route names something that is not a token contract");
    }
    if (addressOf(to!) !== expected.account) throw new Error("the swap does not pay this account");
    const dl = bigOf(deadline!);
    // The same signing buffer the transaction-level timebounds require: a deadline the
    // contract itself will already refuse by the time the user can sign is not a usable swap.
    if (dl === null || dl < BigInt(expected.nowSeconds) + SIGNING_BUFFER_SECONDS) {
      throw new Error("the deadline leaves no time to sign");
    }
    return;
  }
  if (args.length === 7) {
    // Aggregator: (token_in, token_out, amount_in, amount_out_min, distribution, to, deadline).
    const [tokenIn, tokenOut, amountIn, minOut, distribution, to, deadline] = args;
    if (addressOf(tokenIn!) !== expected.token) throw new Error("token_in is not this token");
    if (addressOf(tokenOut!) !== expected.xlm) throw new Error("token_out is not XLM");
    if (bigOf(amountIn!) !== expected.amountIn)
      throw new Error("amount_in is not the live balance");
    const min = bigOf(minOut!);
    if (min === null || min < expected.minOut)
      throw new Error("amount_out_min is below your floor");
    if (distribution!.switch() !== xdr.ScValType.scvVec()) {
      throw new Error("distribution is not a list");
    }
    if (addressOf(to!) !== expected.account) throw new Error("the swap does not pay this account");
    const dl = bigOf(deadline!);
    if (dl === null || dl < BigInt(expected.nowSeconds) + SIGNING_BUFFER_SECONDS) {
      throw new Error("the deadline leaves no time to sign");
    }
    return;
  }
  throw new Error(`the swap takes 5 or 7 arguments, found ${args.length}`);
}

/**
 * Walks one authorized invocation: every contract must be one a conversion may reach, every
 * transfer of the token must be the account's own and to a contract, and nothing may be deeper
 * than a route needs. Returns the token amount the tree moves out of the account.
 */
function walkAuth(
  node: xdr.SorobanAuthorizedInvocation,
  expected: ExpectedConversion,
  depth: number
): bigint {
  if (depth > MAX_AUTH_DEPTH) throw new Error("the authorization tree nests deeper than a swap");
  const fn = node.function();
  if (fn.switch() !== xdr.SorobanAuthorizedFunctionType.sorobanAuthorizedFunctionTypeContractFn()) {
    throw new Error("the signature would authorize something other than a contract call");
  }
  const call = fn.contractFn();
  const contract = Address.fromScAddress(call.contractAddress()).toString();
  const name = call.functionName().toString();
  const reachable = new Set([
    ...expected.allowed.aggregator,
    ...expected.allowed.adapters,
    ...expected.allowed.routers,
    expected.token,
  ]);
  if (!reachable.has(contract)) {
    throw new Error(
      `the signature would authorize a call on ${short(contract)}, which no swap needs`
    );
  }
  let moved = 0n;
  if (contract !== expected.token && !name.startsWith("swap")) {
    // A prefix rather than an exact name: the aggregator, its adapters, and the router each have
    // their own swap entry points, and a route may legitimately use any of them. What this rules
    // out is everything that is not a swap at all - an admin call, an upgrade, an approval.
    throw new Error(
      `the signature would authorize ${name} on ${short(contract)}, which is not a swap`
    );
  }
  if (contract === expected.token) {
    if (name !== "transfer") throw new Error(`the signature would authorize ${name} on the token`);
    const args = call.args();
    if (args.length !== 3) throw new Error("a token transfer takes three arguments");
    if (addressOf(args[0]!) !== expected.account) {
      throw new Error("a token transfer would spend a balance other than this account's");
    }
    const to = addressOf(args[1]!);
    if (to === null || !CONTRACT_ID.test(to)) {
      throw new Error("a token transfer would pay a Stellar account, not a pool");
    }
    const amount = bigOf(args[2]!);
    if (amount === null || amount <= 0n) throw new Error("a token transfer has no readable amount");
    moved += amount;
  }
  for (const arg of call.args()) {
    // No Stellar account may appear anywhere but as the account itself.
    collectAccounts(arg, expected.account);
  }
  for (const sub of node.subInvocations()) moved += walkAuth(sub, expected, depth + 1);
  return moved;
}

/**
 * Refuses a built swap whose shape is anything but the one described above. Exported for direct
 * coverage; the round below calls it on every build before offering the transaction.
 */
export function assertConversionShape(tx: Transaction, expected: ExpectedConversion): void {
  if (tx.source !== expected.account) throw new Error("the transaction is not this account's");
  if (tx.sequence !== (BigInt(expected.sequence) + 1n).toString()) {
    throw new Error("the transaction is not this account's next transaction");
  }
  if (tx.memo.type !== "none") throw new Error("the swap carries a memo");
  if (BigInt(tx.fee) > BigInt(MAX_SOROBAN_EXIT_FEE_STROOPS)) {
    throw new Error("the fee exceeds what a swap can need");
  }
  // A swap must expire, and not before it can be signed. Without an upper time bound a signed
  // swap stays submittable indefinitely, at whatever rate the market reaches later.
  const maxTime = tx.timeBounds ? BigInt(tx.timeBounds.maxTime) : 0n;
  if (maxTime === 0n) throw new Error("the swap never expires");
  if (maxTime < BigInt(expected.nowSeconds) + SIGNING_BUFFER_SECONDS) {
    throw new Error("the transaction expires before it can be signed");
  }
  const ops = tx.toEnvelope().v1().tx().operations();
  if (ops.length !== 1) throw new Error(`expected one operation, found ${ops.length}`);
  const op = ops[0]!;
  const src = op.sourceAccount();
  if (src) {
    if (
      src.switch() !== xdr.CryptoKeyType.keyTypeEd25519() ||
      Address.account(src.ed25519()).toString() !== expected.account
    ) {
      throw new Error("the operation acts for another account");
    }
  }
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
  const entry = [...expected.allowed.aggregator, ...expected.allowed.routers];
  if (!entry.includes(contract)) {
    throw new Error(
      `the swap is not a call on Soroswap's aggregator or router (${short(contract)})`
    );
  }
  if (call.functionName().toString() !== SWAP_FUNCTION) {
    throw new Error(`the call is ${call.functionName().toString()}, not ${SWAP_FUNCTION}`);
  }
  assertSwapArgs(call.args(), expected);

  if (host.auth().length === 0) throw new Error("the build produced no authorization for the swap");
  let moved = 0n;
  for (const auth of host.auth()) {
    if (
      auth.credentials().switch() !== xdr.SorobanCredentialsType.sorobanCredentialsSourceAccount()
    ) {
      throw new Error("an authorization entry carries credentials other than the account's own");
    }
    const root = auth.rootInvocation();
    const rootFn = root.function();
    if (
      rootFn.switch() !==
      xdr.SorobanAuthorizedFunctionType.sorobanAuthorizedFunctionTypeContractFn()
    ) {
      throw new Error("an authorization entry is not a plain contract call");
    }
    const rootCall = rootFn.contractFn();
    if (
      Address.fromScAddress(rootCall.contractAddress()).toString() !== contract ||
      rootCall.functionName().toString() !== SWAP_FUNCTION
    ) {
      throw new Error("an authorization entry authorizes a call other than this swap");
    }
    moved += walkAuth(root, expected, 1);
  }
  if (moved > expected.amountIn) {
    throw new Error("the signature would let more of the token leave than the swap spends");
  }
}

/**
 * Builds the next token conversion, or null when no held token is due to be converted. Every
 * refusal is a named 422 for the client to act on; `quote_drifted` asks for a fresh decision.
 */
export async function buildTokenConversionRound(
  accountState: AccountState,
  dispositions: Record<string, AssetDisposition>,
  floors: Record<string, { minAmountOut: string; provider: "soroswap" | "xbull" }>,
  network: Network,
  sequence: string,
  validUntilLedger: number,
  deps: TokenConversionRoundDeps
): Promise<TokenConversionRound | null> {
  const answered = Object.keys(dispositions)
    .filter((c) => CONTRACT_ID.test(c) && dispositions[c] === "convert")
    .sort();
  if (answered.length === 0) return null;
  const read = accountState.sorobanTokens;
  const readFellShort =
    !read ||
    read.warnings.some(
      (w) => w.code === "soroban_tokens_partial" || w.code === "soroban_tokens_unreadable"
    );
  const unaccounted = answered.filter(
    (c) =>
      !read?.tokens.some((t) => t.contract === c) && (readFellShort || read.unreadable.includes(c))
  );
  if (unaccounted.length > 0) {
    throw new TokenTransferBlockedError(
      "soroban_token_unreadable",
      `The ${unaccounted.map(short).join(", ")} token balance could not be re-read, so its ` +
        "conversion cannot be built. Retry the analysis."
    );
  }
  const due = (read?.tokens ?? []).map((t) => t.contract).filter((c) => answered.includes(c));
  const passphrase = NETWORK_PASSPHRASES[network];
  const account = accountState.address;
  const allowed = deps.allowed(network);
  const allowedXBull = deps.xbullAllowed(network);
  const xlm = xlmContractId(network);

  for (let i = 0; i < due.length; i++) {
    const token = due[i]!;
    const meta = read!.tokens.find((t) => t.contract === token)!;
    const name = meta.symbol ?? short(token);
    if (meta.symbol === null || meta.decimals === null) {
      // Without decimals no amount shown about this swap means anything, so it is not a decision
      // anyone could have made. The plan never offers convert for such a token; an API caller
      // that answers it anyway is refused rather than shown a figure nobody can read.
      throw new TokenTransferBlockedError(
        "soroban_token_conversion_unavailable",
        `The ${name} token does not report its symbol and decimals, so it cannot be exchanged. ` +
          "Send it to another account, or leave it on record."
      );
    }
    const pinned = floors[token]; // { minAmountOut, provider }, never a bare string (Step 4)
    if (pinned === undefined) {
      throw new TokenTransferBlockedError(
        "conversion_floor_missing",
        `Converting ${name} needs the least XLM you were shown it would deliver (params.minAmountOut).`
      );
    }
    const provider = pinned.provider;
    const floor = BigInt(pinned.minAmountOut);
    const balance = await liveTokenBalance(deps.rpc, network, account, token);
    if (balance === null) {
      throw new TokenTransferBlockedError(
        "soroban_token_unreadable",
        `The ${name} token would not report this account's balance, so its conversion cannot be ` +
          "built. Retry the analysis."
      );
    }
    if (balance <= 0n) continue;

    if (provider === "xbull") {
      // The plan showed the user an xBull quote and they accepted it; this build never falls
      // back to Soroswap even if it would now quote better - that would build a swap the user
      // never saw priced.
      if (allowedXBull.router.length === 0) {
        throw new TokenTransferBlockedError(
          "soroban_token_conversion_unavailable",
          `Converting ${name} through xBull is not available right now: the contract registry ` +
            "has no verified xBull entry for this network. Send it to another account, or leave it on record."
        );
      }
      const quote = await quoteTokenToXlmViaXBull(token, balance, network, deps.xbull.xbull);
      if (!quote) {
        throw new TokenTransferBlockedError(
          "soroban_token_route_lost",
          `There is no longer a route through xBull to exchange ${name} for XLM. Send it to ` +
            "another account, or leave it on record."
        );
      }
      const freshFloor = BigInt(quote.minAmountOut);
      if (freshFloor < floor) {
        throw new TokenTransferBlockedError(
          "quote_drifted",
          `The market moved: exchanging ${formatTokenAmount(balance.toString(), meta.decimals)} ${name} ` +
            `now delivers at least ${stroopsToXlm(quote.minAmountOut)} XLM, below the ` +
            `${stroopsToXlm(pinned.minAmountOut)} XLM you agreed to. Review the plan again to accept the new rate.`
        );
      }
      const built = await buildXBullConversion(
        {
          token,
          route: (quote.raw as { route: string }).route,
          amountIn: balance.toString(),
          minAmountOut: freshFloor.toString(),
        },
        account,
        network,
        sequence,
        deps.xbull
      );
      if (!built) {
        throw new TokenTransferBlockedError(
          "soroban_token_conversion_failed",
          `The swap for ${name} could not be built through xBull right now. Retry, send the ` +
            "balance to another account, or leave it on record."
        );
      }
      const xdrBase64 = built.xdr;
      let tx: Transaction;
      try {
        tx = TransactionBuilder.fromXDR(xdrBase64, passphrase) as Transaction;
        if (!("operations" in tx)) throw new Error("not a plain transaction");
        // resolvePath takes the raw contractArgsXDR buildXBullConversion fetched from xBull,
        // never the assembled transaction XDR - a different, smaller XDR structure that
        // resolvePath's own implementation (resolveXBullPath, above) parses directly.
        const resolvedPath = await deps.xbull.resolvePath(built.contractArgsXDR);
        assertXBullConversionShape(tx, {
          token,
          account,
          xlm,
          amountIn: balance,
          minOut: freshFloor,
          resolvedPath,
          allowed: allowedXBull,
          sequence,
          nowSeconds: Math.floor(deps.xbull.xbull.now() / 1000),
        });
        // The address is in the registry; the code behind it must be what the registry verified.
        const called = Address.fromScAddress(
          tx
            .toEnvelope()
            .v1()
            .tx()
            .operations()[0]!
            .body()
            .invokeHostFunctionOp()
            .hostFunction()
            .invokeContract()
            .contractAddress()
        ).toString();
        const hash = await readLiveWasmHash(deps.rpc, called);
        const resolved = resolveWasmHash(network, hash ?? "");
        if (
          resolved.status !== "known" ||
          resolved.protocol !== "xbull" ||
          resolved.kind !== "router"
        ) {
          throw new Error("the contract behind the swap is not the code the registry verified");
        }
      } catch (err) {
        throw new TokenTransferBlockedError(
          "soroban_token_conversion_unsafe",
          `The swap for ${name} could not be offered for signing: ` +
            `${err instanceof Error ? err.message : String(err)}. Send the balance to another ` +
            "account, or leave it on record."
        );
      }
      return {
        transaction: {
          id: "tx-1",
          order: 0,
          dependsOn: [],
          xdr: xdrBase64,
          networkPassphrase: passphrase,
          sourceSequence: sequence,
          validUntilLedger,
          covers: ["HANDLE_ASSETS"],
          coversTargets: [token],
          intent: {
            ...intentFromXdr(xdrBase64, passphrase),
            summary:
              `Exchange ${formatTokenAmount(balance.toString(), meta.decimals)} ${name} for at least ` +
              `${stroopsToXlm(pinned.minAmountOut)} XLM through xBull`,
          },
        },
        remainingSteps: due.length - i - 1,
      };
    }

    // provider === "soroswap": the original body, unchanged below this point except reading
    // `pinned.minAmountOut` instead of the old bare `floorRaw`, and the summary text staying
    // "through Soroswap" explicitly (rather than a shared variable) so a reviewer sees at a
    // glance that this branch's behavior is byte-for-byte what shipped before this feature.
    const quote = await quoteTokenToXlm(token, balance, network, deps.conversion);
    if (!quote) {
      throw new TokenTransferBlockedError(
        "soroban_token_route_lost",
        `There is no longer a route to exchange ${name} for XLM. Send it to another account, or ` +
          "leave it on record."
      );
    }
    const freshFloor = BigInt(quote.minAmountOut);
    if (freshFloor < floor) {
      throw new TokenTransferBlockedError(
        "quote_drifted",
        `The market moved: exchanging ${formatTokenAmount(balance.toString(), meta.decimals)} ${name} ` +
          `now delivers at least ${stroopsToXlm(quote.minAmountOut)} XLM, below the ` +
          `${stroopsToXlm(pinned.minAmountOut)} XLM you agreed to. Review the plan again to accept the new rate.`
      );
    }
    if (allowed.aggregator.length === 0 && allowed.routers.length === 0) {
      throw new TokenTransferBlockedError(
        "soroban_token_conversion_unavailable",
        `Converting ${name} is not available right now: the contract registry has no verified ` +
          "Soroswap entries for this network. Send it to another account, or leave it on record."
      );
    }
    const xdrBase64 = await buildTokenConversion(quote, account, network, deps.conversion);
    if (!xdrBase64) {
      throw new TokenTransferBlockedError(
        "soroban_token_conversion_failed",
        `The swap for ${name} could not be built right now. Retry, send the balance to another ` +
          "account, or leave it on record."
      );
    }
    let tx: Transaction;
    try {
      tx = TransactionBuilder.fromXDR(xdrBase64, passphrase) as Transaction;
      if (!("operations" in tx)) throw new Error("not a plain transaction");
      assertConversionShape(tx, {
        token,
        account,
        xlm,
        amountIn: balance,
        // The fresh quote's floor, not the user's: it is quoted for the balance actually being
        // spent, so a balance that grew since the plan cannot clear a floor computed for a
        // smaller one. It is never below what the user accepted - the drift check above refuses
        // that outright - so this is the same promise or a stricter one.
        minOut: freshFloor,
        allowed,
        sequence,
        nowSeconds: Math.floor(deps.conversion.now() / 1000),
      });
      // The address is in the registry; the code behind it must be what the registry verified.
      const called = Address.fromScAddress(
        tx
          .toEnvelope()
          .v1()
          .tx()
          .operations()[0]!
          .body()
          .invokeHostFunctionOp()
          .hostFunction()
          .invokeContract()
          .contractAddress()
      ).toString();
      const hash = await readLiveWasmHash(deps.rpc, called);
      const resolved = resolveWasmHash(network, hash ?? "");
      if (
        resolved.status !== "known" ||
        resolved.protocol !== "soroswap" ||
        (resolved.kind !== "aggregator" && resolved.kind !== "router")
      ) {
        throw new Error("the contract behind the swap is not the code the registry verified");
      }
    } catch (err) {
      throw new TokenTransferBlockedError(
        "soroban_token_conversion_unsafe",
        `The swap for ${name} could not be offered for signing: ` +
          `${err instanceof Error ? err.message : String(err)}. Send the balance to another ` +
          "account, or leave it on record."
      );
    }
    return {
      transaction: {
        id: "tx-1",
        order: 0,
        dependsOn: [],
        xdr: xdrBase64,
        networkPassphrase: passphrase,
        sourceSequence: sequence,
        validUntilLedger,
        covers: ["HANDLE_ASSETS"],
        coversTargets: [token],
        intent: {
          ...intentFromXdr(xdrBase64, passphrase),
          summary:
            `Exchange ${formatTokenAmount(balance.toString(), meta.decimals)} ${name} for at least ` +
            `${stroopsToXlm(pinned.minAmountOut)} XLM through Soroswap`,
        },
      },
      remainingSteps: due.length - i - 1,
    };
  }
  return null;
}
