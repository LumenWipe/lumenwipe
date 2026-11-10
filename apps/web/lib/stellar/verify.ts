import { NETWORK_PASSPHRASES, type Network } from "@/config/networks";
import {
  bundledExchange,
  bundledRegistry,
  isRegistryUsable,
  lookupExchange,
  mediatorAllowedFor,
  memoTypeInDispute,
  type RegistryEntry,
} from "@/lib/exchange-registry";
import { appliesOn, isUsableAt, mergeServedRegistry } from "@/lib/exchange-registry/merge";
import { intentFromXdr } from "@/lib/stellar/intent/serialize";
import { VerificationError } from "@/lib/stellar/verification-error";
import { xlmToStroops } from "@/lib/utils/amounts";
import type { AccountSigner, AccountThresholds } from "@/types/account";
import type { IntentOperation, TxIntent } from "@/types/close-api";

/** A DeFi exit's fee comes from the API's simulation, not from a fixed per-operation rate, so it
 *  is the one fee the client cannot predict. A real exit costs a few thousand stroops; this cap
 *  (1 XLM) bounds what a wrong or hostile simulation could make the account pay to the fee pool. */
const MAX_EXIT_FEE_STROOPS = BigInt(10_000_000);

/** Ten times the 100-stroop base fee the builder sets per operation: room for surge pricing, and
 *  at most 0.01 XLM for a full 100-operation transaction. */
const MAX_CLASSIC_FEE_PER_OPERATION_STROOPS = BigInt(1_000);

/** The builder gives every transaction 300 seconds; the rest absorbs a browser clock running up
 *  to ten minutes behind. Keeps a signed envelope tied to the moment the user reviewed it. */
const MAX_VALIDITY_SECONDS = 900;

export { VerificationError };

/** What the client independently knows a close transaction should look like. */
export interface CloseExpectation {
  /** The account being closed. */
  source: string;
  /** The user's chosen final destination. */
  destination: string;
  /** Whether the user's destination routes through the shared intermediary.
   *  `verifyCloseTransaction` derives it from the bundled exchange registry alone; the caller
   *  does not pass it. Without it the two-operation hand-off would be accepted for a close the
   *  user asked to send straight to their own wallet. */
  mediatorRequired: boolean;
  /** Whether the destination cannot be merged into directly: an exchange the registry lists as
   *  needing the intermediary, which credits a payment carrying a memo but not an account merge.
   *  `verifyCloseTransaction` derives it from the active registry (or the served snapshot passed
   *  to it), whose served entries can only add to the bundled ones. */
  directMergeRefused: boolean;
  /** The account's native balance in XLM as the client last read it. The floor under the
   *  forwarded amount: the intermediary is only a conduit if what leaves it is what arrived. */
  nativeBalance: string;
  /** The memo the user confirmed, or null. */
  memo: string | null;
  /** Contracts the account's analysis showed it holds DeFi positions in - the only contracts a
   *  DeFi exit may invoke. From the account read the user reviewed; empty fails closed. */
  exitContracts: string[];
  /** The Stellar Asset Contract of every asset the account holds (native and each trustline).
   *  Derived client-side from the account read. */
  heldTokenContracts: string[];
  /** The tokens of each detected position (an LP pair's two tokens) - what a withdrawal pays out.
   *  With the two lists above, the only contracts a DeFi exit may name. */
  positionTokenContracts: string[];
  /** Per contract an exit may invoke, the one function that leaves that protocol. */
  exitFunctions: Record<string, string[]>;
  /** The bundled registry's Soroswap aggregator/router and xBull's router: the only contracts
   *  a token conversion may be entered through. From the registry alone, never from the API. */
  conversionContracts: string[];
  /** Whether the destination requires a memo (from the client-bundled exchange registry). */
  memoRequired: boolean;
  /** The type `memo` must carry: the registry's for a listed exchange, the user's choice for any
   *  other destination. Read only when `memo` is set. */
  memoType: "text" | "id" | "hash" | null;
  /**
   * The per-asset payments the user chose, keyed by canonical `CODE:ISSUER`: a transfer to the
   * account they named, with the balance they were shown as a floor, or a return to the issuer
   * of an asset they chose to return. Every payment but the mediated forward must match one.
   *
   * The destination and the choice come from the user's own decisions, never from the plan or
   * the transaction under verification. The amount is the balance from the account read, which
   * comes from the same API that builds the transaction, so it catches builder bugs and partial
   * compromise rather than an adversary who keeps both consistent. It is a floor rather than an
   * exact figure: a claim round can raise the balance before the build, and paying more to an
   * already-pinned destination is not a loss.
   */
  transfers: Record<string, { destination: string; amount: string }>;
  /**
   * The Soroban token transfers the user chose, keyed by token contract: the account each balance
   * goes to and the balance the client read, in the token's base units. The invoke rule for a
   * contract in this map is the transfer rule, not the DeFi-exit rule: the call must be that
   * token's `transfer(account, destination, amount)` with nothing else authorized.
   */
  tokenTransfers: Record<string, { destination: string; amount: string }>;
  /** Per transfer destination the exchange registry lists, the exchange's name. A transfer
   *  outside the merge carries no deposit memo, so none of these could credit it.
   *  `verifyCloseTransaction` derives it from the active registry; the caller does not pass it. */
  depositAddresses: Record<string, string>;
  /**
   * The Soroban token conversions the user chose, keyed by token contract, each with the least
   * XLM (in stroops) the plan quoted and they accepted.
   *
   * The floor is the whole point. A swap's destination is structurally constrained - the proceeds
   * must be paid to the account being closed - so the diversion a transfer risks does not apply
   * here; what an adversary could do instead is route the balance through a pool that returns
   * almost nothing. Holding the built swap's own `amount_out_min` to the figure the user was
   * shown is what makes that impossible, and the figure comes from their own decision, never from
   * the plan under verification.
   *
   * `resolvedPath` rides along for a token whose winning quote was xBull's, as the API resolved
   * it at plan time. `verify()` does not rely on it: it reads an xBull route through
   * `xbullAssets`, which is bundled.
   */
  tokenConversions: Record<
    string,
    { minAmountOut: string; amountOut?: string; amountIn: string; resolvedPath?: string[] }
  >;
  /**
   * The classic conversions the user chose, keyed by `CODE:ISSUER`, with the least XLM (stroops)
   * the plan showed each delivering. Null for an asset only an exit pays in: it had no amount to
   * quote, so only the choice and a positive minimum are held. Only these assets may be sold.
   */
  classicConversions: Record<string, { minAmountOut: string | null }>;
  /** Every contract the bundled registry names on this network. */
  registryContracts: string[];
  /** XLM's contract and the contract of every classic asset the account holds. A DeFi exit
   *  through a contract outside the registry may not touch these at all. */
  protectedTokenContracts: string[];
  /** xBull's router asset table from the bundle, index to token contract. The only way an xBull
   *  route's opaque indices are read; an index missing here fails the swap closed. */
  xbullAssets: Record<string, string>;
  /** Per position contract, the tokens the account read names as that position's own. Through a
   *  contract outside the registry, an exit may touch only these, and never a protected token. */
  ownTokensByContract: Record<string, string[]>;
  /** Per Blend pool, the tokens the account read shows a debt in. At a registry contract, the only
   *  XLM or classic asset an exit may authorize spending, and only as a repay into that pool. */
  repayTokensByPool: Record<string, string[]>;
  /** The share tokens the account read names on its positions (an Aquarius or Phoenix pool's).
   *  Never XLM, a classic asset, or a Soroban balance the read lists: an exit is refused if so. */
  shareTokenContracts: string[];
  /** The debt tokens the account read names on its positions (an FxDAO vault's stablecoin).
   *  Never XLM or a classic asset the account holds: an exit is refused if so. */
  debtTokenContracts: string[];
  /** XLM's own contract on this network, derived client-side from the network passphrase. The one
   *  asset a conversion may buy: without pinning it, the minimum above would be compared against a
   *  figure denominated in whatever the transaction claims to be buying. */
  xlmContract: string;
  /** Assets the user themselves chose to add a trustline for, to claim a balance the account
   *  otherwise cannot reach ("add trustline and claim"). Sourced from the user's own claimable-
   *  balance decisions, never from the API response - the only case a raised (non-removal)
   *  `change_trust` is allowed to pass verification. */
  claimTrustlineAssets: string[];
  /** The account's real signer set at the time it was last read, so a set_options op can be
   *  checked against signers that actually exist on the account, not trusted from the op
   *  alone. Sourced from the account-state read the guided flow already performs (`GET
   *  /api/{network}/account/{id}`) - not from the transaction being verified, but also NOT a
   *  user-input-only guarantee like `destination`/`memo`/`claimTrustlineAssets` above: it comes
   *  from the same API that builds the transaction under verification, so this check hardens
   *  against transaction-builder bugs and partial compromise, not against a wholly hostile API
   *  that could keep its account-state read and its transaction mutually consistent. */
  accountSigners: AccountSigner[];
  /** The account's real per-category thresholds at the time it was last read, from the same
   *  account-state read as `accountSigners` above (same caveat applies). Not consumed by
   *  any check in this module yet - carried through for the signature-accumulation engine
   *  (multisig epic #97, issue #2) that computes how much signing weight a transaction
   *  actually needs. */
  accountThresholds: AccountThresholds;
  /** When verification runs, in unix seconds from the browser's clock: the reference for the
   *  transaction's expiry. */
  nowSeconds: number;
  /** The user's own transaction, already authorized by a pre-auth-tx signer and only submitted
   *  here: its expiry and fee are the user's, set before this close existed. */
  preAuthorized?: boolean;
}

/**
 * Checks how the account's balance leaves it, and returns the forward payment when the close
 * is mediated (null when it merges straight to the user's own address).
 *
 * Two shapes are legitimate. A direct close merges to the address the user typed. A mediated
 * close merges into an intermediary that forwards the balance on, because exchanges credit
 * payments carrying a memo and cannot credit a merge.
 *
 * The mediated shape is accepted on structure, never on the intermediary's identity:
 *
 *   - exactly two operations, merge first
 *   - the merge is sourced from the account being closed
 *   - the forward is **sent by the account the merge just paid into**
 *   - the forward goes to the address the user typed, in XLM
 *
 * The third condition is the load-bearing one. It makes the intermediary a conduit rather than
 * a destination: it cannot keep the balance, because the same atomic transaction that hands it
 * over also sends it on. Pinning its address instead would prove less - a pinned address that
 * simply never forwards still passes - while forcing every consumer to be told which address
 * to expect, and re-told whenever it rotates.
 */
function assertMergeShape(
  intent: TxIntent,
  expected: CloseExpectation
): Extract<IntentOperation, { type: "payment" }> | null {
  // Every merge, not just the first. `guarantees.mergeDestination` reports the first one, so
  // reading only that would let a second merge - of this account or another the signer has
  // weight on - ride along unexamined behind a well-formed first.
  const merges = intent.operations.filter((o) => o.type === "account_merge");
  if (merges.length === 0) return null;
  if (merges.length > 1) {
    throw new VerificationError(
      "merge_multiple",
      "The transaction would merge more than one account."
    );
  }
  const merge = merges[0]!;

  if (merge.source !== expected.source) {
    throw new VerificationError(
      "operation_source_mismatch",
      "The account merge is not sent by the account being closed."
    );
  }

  // Merging to the address the user typed needs no intermediary and no further shape checks,
  // unless the address is an exchange that needs one. Such an exchange credits a payment
  // carrying a memo and cannot credit a merge, so a merge straight into it delivers the balance
  // to the right address uncredited.
  if (merge.destination === expected.destination) {
    if (expected.directMergeRefused) {
      throw new VerificationError(
        "merge_direct_refused",
        "This exchange cannot credit an account merge, so the balance has to reach it as a payment. This transaction would merge your account straight into it."
      );
    }
    return null;
  }

  // The hand-off exists because exchanges cannot be merged into. Accepting it for a close the
  // user routed straight to their own wallet would make an attacker-nominated intermediary
  // reachable for every user, not only the ones closing to an exchange.
  if (!expected.mediatorRequired) {
    throw new VerificationError(
      "merge_destination_mismatch",
      "The account would be merged to an address you did not choose."
    );
  }

  // Anywhere else, the transaction has to be the two-operation hand-off. Anything more is an
  // effect this cannot account for, and anything less means the balance stops at an address
  // the user never named.
  const ops = intent.operations;
  // Stryker disable next-line ConditionalExpression: with ops.length === 2 and exactly one
  // account_merge among all of intent.operations (guaranteed above), ops[0] not being the merge
  // forces the merge to be ops[1] - which then always fails the ops[1]-is-payment check too. The
  // ops[0] term can never be the sole reason this condition is true; removing it changes nothing
  // observable.
  if (ops.length !== 2 || ops[0]!.type !== "account_merge" || ops[1]!.type !== "payment") {
    throw new VerificationError(
      "mediator_handoff_shape",
      "The account would be merged to an address you did not choose, and this transaction does not hand the balance straight on to your destination."
    );
  }

  const forward = ops[1]!;

  if (forward.source !== merge.destination) {
    // Without this the intermediary is just an address funds go to. With it, the account that
    // received the balance is the one sending it on, in the same transaction.
    throw new VerificationError(
      "mediator_forward_source_mismatch",
      "The balance would be handed to one account and forwarded by another. Nothing guarantees the account receiving your funds is the one passing them on."
    );
  }
  if (forward.destination !== expected.destination) {
    throw new VerificationError(
      "mediator_forward_destination_mismatch",
      `The transaction would pay funds to an unexpected address (${forward.destination}).`
    );
  }
  if (forward.asset !== "native") {
    throw new VerificationError(
      "mediator_forward_not_native",
      "The forwarded balance would not be XLM."
    );
  }
  assertForwardCarriesTheBalance(forward.amount, expected.nativeBalance);

  return forward;
}

/**
 * Asserts a decoded close-transaction intent against what the client independently expects,
 * before the browser signs it. Pure: no network, no XDR decoding, no dependency on the wrapper.
 * This is the trust anchor of the non-custodial model once the API builds transactions
 * server-side - an irreversible account merge must never move funds anywhere the user did not
 * choose, and no operation may reach signing that verification cannot account for.
 */
/**
 * Asserts the forwarded amount is the balance, not a token of it.
 *
 * Structure alone does not make an intermediary a conduit. "Whoever received the merge sends a
 * payment onward" is satisfied by forwarding one stroop and keeping the rest - atomicity
 * constrains whether the payment happens, never how much it carries. This is the check that
 * closes that gap, and it is why the mediated shape cannot be accepted on structure alone.
 *
 * A lower bound, not equality: the merge delivers whatever the balance is at execution, which
 * is not known when the transaction is built. The bound is one-sided on purpose - the
 * intermediary gets no freedom upward, only a bounded amount it could retain. Two honest
 * limits: funds arriving between the client's balance read and submission are not covered, and
 * the balance is read from the same API that built the transaction, so this catches builder
 * bugs and partial compromise rather than an adversary who keeps both consistent.
 */
/**
 * Accepts a payment only as a transfer the user themselves chose, matching on all three of
 * asset, destination and amount.
 *
 * Every part of that is load-bearing. Matching only the destination would accept a payment of
 * an asset the user marked `convert`, sent to an account they picked for a different one.
 * Matching only the asset would accept the right token going to the wrong account, which is
 * the diversion this exists to stop. And matching a destination without the amount would let
 * the transaction send one stroop where the user expected the whole balance.
 *
 * Exact equality on the amount, not the floor used for the mediated forward. The forward's
 * delivered amount genuinely cannot be known at build time - a merge delivers whatever the
 * balance is at execution - but a transfer's amount is the trustline balance the client
 * already read and showed the user, so there is nothing to leave slack for. A mismatch means
 * the transaction is not the one that was approved.
 */
/** The functions a token conversion calls; must match the API's `SWAP_FUNCTION` (router) and
 *  `AGGREGATOR_SWAP_FUNCTION`. */
const SWAP_FUNCTION = "swap_exact_tokens_for_tokens";
const AGGREGATOR_SWAP_FUNCTION = "swap_exact_in";
const CONTRACT_ID = /^C[A-Z2-7]{55}$/;

/**
 * SEP-41 functions a DeFi exit's own contract may legitimately call on a token it sub-invokes
 * (a held asset's Stellar Asset Contract, or a position's own token): each function's exact
 * argument count, and which position - if any - holds the recipient or spender that must be
 * pinned. `recipientArg: -1` means the function moves no balance to a named third party (a burn
 * destroys value; there is nothing to pin beyond the account whose balance it burns, which
 * `accountsReferenced` already requires to be the one being closed). `argCount` is checked
 * before `recipientArg` is ever indexed, the same way the existing plain-transfer branch checks
 * `args.length !== 3` before trusting `args[1]` as a destination.
 */
const TOKEN_SUB_INVOCATION_FUNCTIONS: Record<string, { argCount: number; recipientArg: number }> = {
  transfer: { argCount: 3, recipientArg: 1 }, // transfer(from, to, amount)
  transfer_from: { argCount: 4, recipientArg: 2 }, // transfer_from(spender, from, to, amount)
  approve: { argCount: 4, recipientArg: 1 }, // approve(from, spender, amount, expiration_ledger)
  burn: { argCount: 2, recipientArg: -1 }, // burn(from, amount)
  burn_from: { argCount: 3, recipientArg: -1 }, // burn_from(spender, from, amount)
};

/** Blend's RequestType values for leaving a pool: Withdraw, WithdrawCollateral and Repay. */
const BLEND_EXIT_REQUEST_TYPES = [1, 3, 5];

function isBlendExitRequest(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const { address, amount, request_type: type } = value as Record<string, unknown>;
  return (
    Object.keys(value).length === 3 &&
    typeof address === "string" &&
    CONTRACT_ID.test(address) &&
    typeof amount === "string" &&
    /^[1-9]\d*$/.test(amount) &&
    typeof type === "number" &&
    BLEND_EXIT_REQUEST_TYPES.includes(type)
  );
}

/** `submit(from, spender, to, requests)`: the account on every side, and only exit requests. */
function assertBlendSubmitArguments(args: string[], source: string): void {
  if (args.length !== 4 || args.slice(0, 3).some((party) => party !== source)) {
    throw new VerificationError(
      "exit_argument_party_mismatch",
      "A DeFi exit would act for, or pay, an address other than the account being closed."
    );
  }
  let requests: unknown;
  try {
    requests = JSON.parse(args[3]!);
  } catch {
    requests = null;
  }
  if (!Array.isArray(requests) || requests.length === 0 || !requests.every(isBlendExitRequest)) {
    throw new VerificationError(
      "exit_request_not_allowed",
      "A DeFi exit would make a request of a lending pool that LumenWipe does not use to leave it."
    );
  }
}

/** `remove_liquidity(token_a, token_b, liquidity, amount_a_min, amount_b_min, to, deadline)`. */
function assertSoroswapRemovalArguments(args: string[], source: string): void {
  if (args.length !== 7 || args[5] !== source) {
    throw new VerificationError(
      "exit_argument_party_mismatch",
      "A DeFi exit would act for, or pay, an address other than the account being closed."
    );
  }
}

interface SwapArgs {
  /** The token being spent. */
  token: string;
  /** The token being bought. Must be XLM's contract, or the minimum below is in unknown units. */
  assetOut: string;
  /** The amount of `token` the swap spends. */
  amountIn: bigint;
  destination: string;
  minAmountOut: bigint;
}

/**
 * What a swap's arguments name, in the shape of the function called: the router's
 * `swap_exact_tokens_for_tokens(amount_in, amount_out_min, path, to, deadline)`, where the tokens
 * are the path's first and last hops, or the aggregator's
 * `swap_exact_in(user, token_in, amount_in, token_out, min_out, routes, partner)`. Null when the
 * arguments are not that shape, or when the aggregator call names a fee partner, which fails the
 * swap closed.
 *
 * The output token is read, not assumed. Without it the minimum below would be compared against a
 * figure denominated in whatever the transaction says it is buying - a swap into a worthless token
 * would satisfy an "at least N XLM" promise in name only.
 */
function readSwapArgs(fn: string, args: string[]): SwapArgs | null {
  const integer = (value: string | undefined): bigint | null =>
    typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : null;
  if (fn === SWAP_FUNCTION && args.length === 5) {
    let path: unknown;
    try {
      path = JSON.parse(args[2] ?? "");
    } catch {
      return null;
    }
    if (!Array.isArray(path) || path.length < 2) return null;
    if (!path.every((hop) => typeof hop === "string" && CONTRACT_ID.test(hop))) return null;
    const amountIn = integer(args[0]);
    const min = integer(args[1]);
    if (amountIn === null || min === null) return null;
    return {
      token: path[0] as string,
      assetOut: path[path.length - 1] as string,
      amountIn,
      destination: args[3] ?? "",
      minAmountOut: min,
    };
  }
  if (fn === AGGREGATOR_SWAP_FUNCTION && args.length === 7) {
    const token = args[1] ?? "";
    const assetOut = args[3] ?? "";
    const amountIn = integer(args[2]);
    const min = integer(args[4]);
    if (!CONTRACT_ID.test(token) || !CONTRACT_ID.test(assetOut)) return null;
    if (amountIn === null || min === null) return null;
    // A partner replaces the aggregator's own 10 bps fee with its own, from 25 bps up to 10%.
    if (args[6] !== "null") return null;
    return { token, assetOut, amountIn, destination: args[0] ?? "", minAmountOut: min };
  }
  return null;
}

/** The function xBull's PathPayment router calls; must match the API's `XBULL_SWAP_FUNCTION`. */
const XBULL_SWAP_FUNCTION = "strict_send";

interface XBullSwapArgs {
  from: string;
  to: string;
  amount: bigint;
  minToGet: bigint;
  /** The route's `[protocol_id, in_asset_index, pool_id, out_asset_index]` tuples. */
  path: number[][];
  refsCount: number;
}

/**
 * What xBull's `strict_send` call names: `(from, to, amount, min_to_get, path, refs)`, where
 * `path` is a JSON-encoded list of opaque index tuples (the router's own live storage is what
 * resolves them to asset addresses - see `resolveXBullPath` on the API) and `refs` is xBull's
 * referral-fee list, which this module always requires empty. Null when the arguments are not
 * this shape, which fails the swap closed.
 */
function readXBullSwapArgs(args: string[]): XBullSwapArgs | null {
  if (args.length !== 6) return null;
  const [from, to, amount, minToGet, path, refs] = args;
  const amt = /^\d+$/.test(amount ?? "") ? BigInt(amount!) : null;
  const min = /^\d+$/.test(minToGet ?? "") ? BigInt(minToGet!) : null;
  if (amt === null || min === null || !from || !to) return null;
  let parsedPath: unknown;
  let parsedRefs: unknown;
  try {
    parsedPath = JSON.parse(path ?? "");
    parsedRefs = JSON.parse(refs ?? "");
  } catch {
    return null;
  }
  if (!Array.isArray(parsedPath) || !Array.isArray(parsedRefs)) return null;
  const isTuple = (hop: unknown): hop is number[] =>
    Array.isArray(hop) && hop.length === 4 && hop.every((n) => Number.isSafeInteger(n) && n >= 0);
  if (parsedPath.length === 0 || !parsedPath.every(isTuple)) return null;
  return {
    from,
    to,
    amount: amt,
    minToGet: min,
    path: parsedPath,
    refsCount: parsedRefs.length,
  };
}

/** How far under the quoted XLM a swap's floor may sit, whatever floor the plan carried: twice
 *  the 0.5% slippage the API applies to every quote. */
const MAX_SWAP_SLIPPAGE_BPS = BigInt(100);

/** The least XLM a chosen swap may accept: the plan's floor, and never more than
 *  MAX_SWAP_SLIPPAGE_BPS under the quote the user was shown beside it. */
function swapFloor(chosen: { minAmountOut: string; amountOut?: string }): bigint {
  const quoted = chosen.amountOut ?? "";
  if (!/^\d+$/.test(chosen.minAmountOut) || !/^[1-9]\d*$/.test(quoted)) {
    throw new VerificationError(
      "swap_quote_missing",
      "A swap cannot be checked against the quote you were shown. Run the analysis again."
    );
  }
  const fromQuote = (BigInt(quoted) * (BigInt(10_000) - MAX_SWAP_SLIPPAGE_BPS)) / BigInt(10_000);
  const pinned = BigInt(chosen.minAmountOut);
  return pinned > fromQuote ? pinned : fromQuote;
}

/**
 * The tokens an xBull route spends and buys, read from its own index tuples through the bundled
 * asset table. Null when a hop does not continue from the one before it or names an index the
 * table does not hold.
 */
function readXBullRoute(
  path: number[][],
  assets: Record<string, string>
): { spends: string; buys: string } | null {
  const IN = 1;
  const OUT = 3;
  for (let i = 1; i < path.length; i++) {
    if (path[i]![IN] !== path[i - 1]![OUT]) return null;
  }
  const lookup = (index: number): string | undefined =>
    Object.prototype.hasOwnProperty.call(assets, String(index)) ? assets[String(index)] : undefined;
  for (const hop of path) {
    if (lookup(hop[IN]!) === undefined || lookup(hop[OUT]!) === undefined) return null;
  }
  return { spends: lookup(path[0]![IN]!)!, buys: lookup(path[path.length - 1]![OUT]!)! };
}

/**
 * Holds what a swap's signature authorizes below the root call: moving at most `amountIn` of the
 * token being sold, from the account, to a contract on the route, plus swap calls on contracts
 * that are none of the account's own tokens. Any further token movement those calls need would
 * itself appear here, on a token.
 */
function assertSwapAuthorizesOnlyItsInput(
  subInvocations: { contract: string; function: string; args: string[] }[],
  token: string,
  amountIn: bigint,
  expected: CloseExpectation
): void {
  const ownTokens = new Set([
    ...expected.heldTokenContracts,
    ...expected.protectedTokenContracts,
    ...expected.positionTokenContracts,
    expected.xlmContract,
  ]);
  let moved = BigInt(0);
  for (const sub of subInvocations) {
    if (sub.contract !== token) {
      if (ownTokens.has(sub.contract) || !sub.function.startsWith("swap")) {
        throw new VerificationError(
          "swap_auth_unexpected_call",
          "A swap would authorize something other than paying in the token you chose to convert."
        );
      }
      continue;
    }
    if (
      sub.function !== "transfer" ||
      sub.args.length !== 3 ||
      sub.args[0] !== expected.source ||
      !CONTRACT_ID.test(sub.args[1] ?? "") ||
      !/^\d+$/.test(sub.args[2] ?? "")
    ) {
      throw new VerificationError(
        "swap_auth_unexpected_call",
        "A swap would authorize something other than paying in the token you chose to convert."
      );
    }
    moved += BigInt(sub.args[2]!);
  }
  if (moved > amountIn) {
    throw new VerificationError(
      "swap_auth_exceeds_amount",
      "A swap would authorize spending more than the balance it sells."
    );
  }
}

function assertUserChoseThisTransfer(
  op: Extract<IntentOperation, { type: "payment" }>,
  expected: CloseExpectation,
  seen: Set<string>
): void {
  const chosen = expected.transfers[op.asset];
  if (!chosen) {
    throw new VerificationError(
      "transfer_not_chosen",
      `The transaction would pay funds to an unexpected address (${op.destination}).`
    );
  }
  if (op.destination !== chosen.destination) {
    throw new VerificationError(
      "transfer_destination_mismatch",
      `The transaction would send ${assetCode(op.asset)} to an address you did not choose.`
    );
  }
  const exchange = expected.depositAddresses[op.destination];
  if (exchange !== undefined && op.destination !== op.asset.split(":")[1]) {
    throw new VerificationError(
      "transfer_to_deposit_address",
      `The transaction would send ${assetCode(op.asset)} to a ${exchange} deposit address. A transfer in a close carries no deposit memo, so ${exchange} could not credit it. Go back to the plan and choose a wallet you control.`
    );
  }
  if (seen.has(op.asset)) {
    throw new VerificationError(
      "transfer_duplicate",
      `The transaction would send ${assetCode(op.asset)} more than once.`
    );
  }
  seen.add(op.asset);

  // A floor, not equality - and the reason equality looked right is instructive. The amount
  // was described as "the trustline balance the client already read and showed the user, so
  // there is nothing to leave slack for". That is false whenever the close claims a claimable
  // balance of the same asset first: the API's claim round deliberately raises the balance
  // before the close disposes of it, so the second round legitimately pays MORE than the
  // figure shown at analyze time. Equality turned that into a verification failure after the
  // claim had already been signed and submitted, leaving the account half-processed.
  //
  // Paying more is not a loss here, because the destination is already pinned to the account
  // the user named - the extra goes exactly where they said. Paying LESS is the attack: it
  // would mean part of the balance went somewhere else, and anything else leaving the account
  // has to pass this same check. Same one-sided shape as the mediated forward, for the same
  // reason, and compared in whole stroops so no decimal rounding lands where an attacker
  // would aim.
  if (BigInt(xlmToStroops(op.amount)) < BigInt(xlmToStroops(chosen.amount))) {
    throw new VerificationError(
      "transfer_amount_short",
      `The transaction would send less ${assetCode(op.asset)} than you approved.`
    );
  }
}

/**
 * The code half of a canonical "CODE:ISSUER" asset string, for error messages.
 *
 * No "native" case: this is only reached for a payment other than the mediated forward that
 * matched an entry in `expected.transfers`, which is keyed by trustline asset, so XLM cannot
 * appear here. A branch for it would be untestable dead code.
 */
function assetCode(asset: string): string {
  return asset.split(":")[0]!;
}

function assertForwardCarriesTheBalance(forwardAmount: string, nativeBalance: string): void {
  // Compared in whole stroops - a decimal-string comparison would round exactly where an
  // attacker would aim.
  const forwarded = BigInt(xlmToStroops(forwardAmount));
  const observed = BigInt(xlmToStroops(nativeBalance));
  const floor = observed - FORWARD_SHORTFALL_TOLERANCE_STROOPS;

  if (forwarded < floor) {
    throw new VerificationError(
      "mediator_forward_short",
      "This transaction would hand your balance to an intermediary and pass on only part of it."
    );
  }
}

/**
 * How far under the observed balance a forward may fall before it is refused: 0.01 XLM, which
 * covers the network fee the merge consumes and a little drift, and is small enough that
 * anything worth stealing trips it. Raising this raises what an intermediary can keep.
 */
const FORWARD_SHORTFALL_TOLERANCE_STROOPS = BigInt("100000");

function assertExpiresSoon(intent: TxIntent, nowSeconds: number): void {
  const maxTime = intent.maxTime ?? null;
  if (maxTime === null || !/^\d+$/.test(maxTime) || BigInt(maxTime) === BigInt(0)) {
    throw new VerificationError(
      "expiry_missing",
      "This transaction never expires, so it could be submitted long after you approved it."
    );
  }
  if (BigInt(maxTime) > BigInt(Math.floor(nowSeconds)) + BigInt(MAX_VALIDITY_SECONDS)) {
    throw new VerificationError(
      "expiry_too_far",
      "This transaction stays valid for far longer than a close needs. If your device clock is " +
        "wrong, correct it and try again."
    );
  }
}

function assertClassicFee(intent: TxIntent): void {
  if (!/^\d+$/.test(intent.fee)) {
    throw new VerificationError(
      "fee_unreadable",
      "The transaction's network fee could not be read."
    );
  }
  // A Soroban call's fee includes simulated resources; its own branch caps it.
  if (intent.operations.some((op) => op.type === "invoke_host_function")) return;
  const cap = BigInt(intent.operations.length) * MAX_CLASSIC_FEE_PER_OPERATION_STROOPS;
  if (BigInt(intent.fee) > cap) {
    throw new VerificationError(
      "fee_above_cap",
      "This transaction would pay a network fee far above what its operations need."
    );
  }
}

export function assertCloseIntent(intent: TxIntent, expected: CloseExpectation): void {
  // The transaction must be for the account being closed.
  if (intent.source !== expected.source) {
    throw new VerificationError(
      "transaction_source_mismatch",
      "The transaction is not for your account."
    );
  }

  if (!expected.preAuthorized) {
    assertExpiresSoon(intent, expected.nowSeconds);
    assertClassicFee(intent);
  }

  // An exchange close cannot merge to the address the user typed - exchanges credit payments
  // carrying a memo and cannot credit a merge - so the balance goes to an intermediary that
  // immediately forwards it. What makes that safe is not knowing which account the
  // intermediary is, but that the transaction cannot separate the two halves: whoever receives
  // the merge is, in the same atomic transaction, sending the balance on to the address the
  // user chose. Asserting that relationship is strictly stronger than pinning an address, and
  // it needs no configuration - so the intermediary can be rotated without telling anyone.
  const forward = assertMergeShape(intent, expected);

  // One transfer per asset. Without this, a transaction could repeat the payment the user
  // approved and drain the balance in multiples - each copy individually matching the choice.
  const seenTransfers = new Set<string>();
  const seenConversions = new Set<string>();

  for (const op of intent.operations) {
    switch (op.type) {
      case "payment": {
        // Who pays, before what is paid. Every other fund-moving shape here is source-bound -
        // the merge must be sent by the account being closed, the mediated forward by whoever
        // the merge just paid - and a payment was the one that was not, because until transfers
        // existed the only accepted shapes were structurally pinned by their destination.
        //
        // On Stellar one signature satisfies every operation whose source lists that key with
        // enough weight, so a key that signs for two accounts would otherwise authorize a close
        // of one and a debit of the other in the same transaction. The forward is exempt: it is
        // sent by the intermediary, and `assertMergeShape` has already pinned its source to the
        // account the merge paid into.
        if (op !== forward && op.source !== expected.source) {
          throw new VerificationError(
            "operation_source_mismatch",
            "The transaction would pay funds from an account other than the one being closed."
          );
        }
        // Anything but the forward is a payment the user chose: a transfer to the account they
        // named, or a return to the issuer of an asset they chose to return.
        if (op !== forward) {
          assertUserChoseThisTransfer(op, expected, seenTransfers);
        }
        break;
      }
      case "path_payment_strict_send": {
        // Conversions must swap to XLM into the account itself, with a positive floor.
        if (op.destination !== expected.source) {
          throw new VerificationError(
            "conversion_recipient_mismatch",
            "A conversion would send funds out of your account."
          );
        }
        if (op.destAsset !== "native") {
          throw new VerificationError(
            "conversion_not_to_xlm",
            "A conversion would not settle in XLM."
          );
        }
        if (!(Number(op.destMin) > 0)) {
          throw new VerificationError(
            "conversion_min_out_missing",
            "A conversion has no minimum-received floor."
          );
        }
        const chosen = expected.classicConversions[op.sendAsset];
        if (!chosen) {
          throw new VerificationError(
            "conversion_asset_not_chosen",
            "A conversion would sell an asset you did not choose to convert. If a balance arrived " +
              "since the analysis, run it again."
          );
        }
        if (seenConversions.has(op.sendAsset)) {
          throw new VerificationError(
            "conversion_duplicate",
            `The transaction would convert ${assetCode(op.sendAsset)} more than once.`
          );
        }
        seenConversions.add(op.sendAsset);
        if (
          chosen.minAmountOut !== null &&
          BigInt(xlmToStroops(op.destMin)) < BigInt(chosen.minAmountOut)
        ) {
          throw new VerificationError(
            "conversion_min_out_below_floor",
            `A conversion of ${assetCode(op.sendAsset)} would accept less XLM than the minimum you were shown.`
          );
        }
        break;
      }
      case "change_trust":
        // The close only removes trustlines (limit 0, however the amount decodes) - with one
        // narrow exception: a raised trustline for an asset the user themselves chose to add
        // in order to claim an otherwise-unreachable balance ("add trustline and claim").
        if (Number(op.limit) !== 0 && !expected.claimTrustlineAssets.includes(op.asset)) {
          throw new VerificationError(
            "trustline_not_removal",
            "A trustline would be created or raised, not removed."
          );
        }
        break;
      case "manage_data":
        // The close only deletes data entries.
        if (op.value !== null) {
          throw new VerificationError(
            "data_entry_not_removal",
            "A data entry would be written, not removed."
          );
        }
        break;
      case "manage_sell_offer":
        // The close only cancels offers (amount 0).
        if (Number(op.amount) !== 0) {
          throw new VerificationError(
            "offer_not_cancellation",
            "An offer would be created, not cancelled."
          );
        }
        break;
      case "set_options":
        // Signer normalization may only remove signers, never add/empower one, and the signer
        // it touches must be one that actually exists on the account - otherwise the op has no
        // legitimate purpose in a close and its presence is unexplained. Never changes the
        // master key's weight, and only lowers thresholds (normalization sets them to 0/1/1).
        if (op.signer !== null) {
          const signer = op.signer;
          if (signer.weight !== 0) {
            throw new VerificationError("signer_added", "A signer would be added or empowered.");
          }
          const touchesKnownSigner = expected.accountSigners.some(
            (s) => s.key === signer.key && s.type === signer.type
          );
          if (!touchesKnownSigner) {
            throw new VerificationError(
              "signer_unknown",
              "This transaction touches a signer that wasn't on your account when we last read it. Re-run the analysis and try again."
            );
          }
        }
        if (op.masterWeight !== null) {
          throw new VerificationError(
            "master_weight_changed",
            "The master key's weight would be changed."
          );
        }
        if (
          (op.lowThreshold ?? 0) > 1 ||
          (op.medThreshold ?? 0) > 1 ||
          (op.highThreshold ?? 0) > 1
        ) {
          throw new VerificationError("thresholds_raised", "Account thresholds would be raised.");
        }
        if (
          op.homeDomain !== null ||
          op.setFlags !== null ||
          op.clearFlags !== null ||
          op.inflationDest !== null
        ) {
          throw new VerificationError(
            "account_settings_changed",
            "This transaction would change account flags, the home domain, or the inflation destination, which a close never legitimately needs to touch."
          );
        }
        break;
      case "invoke_host_function": {
        // A conversion of a Soroban token the user chose to swap for XLM. The API built these
        // bytes through the Soroswap API and asserted their shape server-side; this is the same
        // assertion made again from the user's own inputs, which is the only version that counts:
        // the contract comes from the bundled registry, the token and the floor from their
        // decision. What is checked here is that the swap spends the token they chose, pays the
        // proceeds to this account and no other, and may not deliver less XLM than they accepted.
        //
        // Not checked here, deliberately: which pools the route passes through. Those addresses
        // are route-dependent and unbounded, and the browser has no way to enumerate them. The
        // API pins them - the whole authorization tree must invoke only the aggregator, its
        // adapters, the router, and the token itself - so this is the residual trust documented
        // in architecture.md §10.1, bounded by the floor above.
        //
        // Claimed by the FUNCTION as well as the contract, not by the contract alone. Soroswap's
        // router serves both roles: a token conversion enters through it, and a Soroswap LP exit
        // calls `remove_liquidity` on it. Matching on the contract alone made the swap rules the
        // only rules that could ever apply to it, so every real Soroswap exit was refused as a
        // malformed swap and no such position could be closed from the browser at all. An
        // operation that is not a swap falls through to the exit branch below, which pins the
        // contract to a position the analysis found and the function to the one that leaves that
        // protocol - so nothing is admitted here that was not admitted before.
        if (
          expected.conversionContracts.includes(op.contract) &&
          (op.function === SWAP_FUNCTION ||
            op.function === AGGREGATOR_SWAP_FUNCTION ||
            op.function === XBULL_SWAP_FUNCTION)
        ) {
          if (intent.operations.length !== 1) {
            throw new VerificationError(
              "invocation_not_alone",
              "A swap must be the only operation in its transaction."
            );
          }
          if (BigInt(intent.fee) > MAX_EXIT_FEE_STROOPS) {
            throw new VerificationError(
              "fee_above_cap",
              "A swap would pay a network fee far above what any swap needs."
            );
          }
          if (op.source !== expected.source) {
            throw new VerificationError(
              "operation_source_mismatch",
              "A swap would act for an account other than the one being closed."
            );
          }
          if (op.function === SWAP_FUNCTION || op.function === AGGREGATOR_SWAP_FUNCTION) {
            const swap = readSwapArgs(op.function, op.args);
            if (!swap) {
              throw new VerificationError(
                "swap_args_unreadable",
                "A swap's arguments could not be read."
              );
            }
            const chosen = expected.tokenConversions[swap.token];
            if (!chosen) {
              throw new VerificationError(
                "conversion_asset_not_chosen",
                "A swap would exchange a token you did not choose to convert."
              );
            }
            if (swap.assetOut !== expected.xlmContract) {
              throw new VerificationError(
                "conversion_not_to_xlm",
                "A swap would buy something other than XLM."
              );
            }
            if (swap.amountIn < BigInt(chosen.amountIn)) {
              throw new VerificationError(
                "conversion_amount_short",
                "A swap would exchange less of the token than the balance you were shown. If you " +
                  "moved some of it since, run the analysis again."
              );
            }
            if (swap.destination !== expected.source) {
              throw new VerificationError(
                "conversion_recipient_mismatch",
                "A swap would pay the proceeds to an address other than the account being closed."
              );
            }
            if (swap.minAmountOut < swapFloor(chosen)) {
              throw new VerificationError(
                "conversion_min_out_below_floor",
                "A swap would accept less XLM than the minimum you were shown."
              );
            }
            assertSwapAuthorizesOnlyItsInput(
              op.subInvocations,
              swap.token,
              swap.amountIn,
              expected
            );
          } else {
            // xBull's shape names its route only by index tuples into the router's own asset
            // table, so the tokens it spends and buys are read through the bundled copy of it.
            const swap = readXBullSwapArgs(op.args);
            if (!swap) {
              throw new VerificationError(
                "swap_args_unreadable",
                "A swap's arguments could not be read."
              );
            }
            if (swap.refsCount !== 0) {
              throw new VerificationError(
                "swap_referral_recipient",
                "A swap would pay a referral fee to an address you never agreed to."
              );
            }
            const route = readXBullRoute(swap.path, expected.xbullAssets);
            if (!route) {
              throw new VerificationError(
                "swap_route_asset_unknown",
                "A swap's route names an asset LumenWipe cannot identify. Run the analysis again."
              );
            }
            const chosen = expected.tokenConversions[route.spends];
            if (!chosen) {
              throw new VerificationError(
                "conversion_asset_not_chosen",
                "A swap would exchange a token you did not choose to convert."
              );
            }
            if (route.buys !== expected.xlmContract) {
              throw new VerificationError(
                "conversion_not_to_xlm",
                "A swap would buy something other than XLM."
              );
            }
            if (swap.amount < BigInt(chosen.amountIn)) {
              throw new VerificationError(
                "conversion_amount_short",
                "A swap would exchange less of the token than the balance you were shown. If you " +
                  "moved some of it since, run the analysis again."
              );
            }
            if (swap.to !== expected.source) {
              throw new VerificationError(
                "conversion_recipient_mismatch",
                "A swap would pay the proceeds to an address other than the account being closed."
              );
            }
            if (swap.minToGet < swapFloor(chosen)) {
              throw new VerificationError(
                "conversion_min_out_below_floor",
                "A swap would accept less XLM than the minimum you were shown."
              );
            }
            assertSwapAuthorizesOnlyItsInput(
              op.subInvocations,
              route.spends,
              swap.amount,
              expected
            );
          }
          if (op.authorizesBeyondSelf) {
            throw new VerificationError(
              "invocation_auth_beyond_self",
              "A swap would authorize actions beyond this account's own contract calls."
            );
          }
          if (op.unsupportedAddressCount > 0) {
            throw new VerificationError(
              "invocation_address_unsupported",
              "A swap names an address form that cannot be verified."
            );
          }
          for (const account of op.accountsReferenced) {
            if (account !== expected.source) {
              throw new VerificationError(
                "invocation_foreign_account",
                "A swap would send funds to, or act for, an account other than the one being closed."
              );
            }
          }
          break;
        }
        // A transfer of a Soroban token the user chose to send as-is. Everything the user decided
        // is checked by value: the token, the account, the destination they typed, and at least
        // the balance they were shown; and the signature may authorize nothing but that one plain
        // call - a token whose transfer nests another invocation is refused. Anything named in the
        // call beyond the account, the destination, and the token itself is a diversion.
        const tokenTransfer = expected.tokenTransfers[op.contract];
        if (tokenTransfer) {
          if (intent.operations.length !== 1) {
            throw new VerificationError(
              "invocation_not_alone",
              "A token transfer must be the only operation in its transaction."
            );
          }
          if (BigInt(intent.fee) > MAX_EXIT_FEE_STROOPS) {
            throw new VerificationError(
              "fee_above_cap",
              "A token transfer would pay a network fee far above what any transfer needs."
            );
          }
          if (op.source !== expected.source) {
            throw new VerificationError(
              "operation_source_mismatch",
              "A token transfer would act for an account other than the one being closed."
            );
          }
          if (op.function !== "transfer" || op.args.length !== 3) {
            throw new VerificationError(
              "token_transfer_function_invalid",
              "A token transaction would call something other than a plain transfer."
            );
          }
          if (op.args[0] !== expected.source) {
            throw new VerificationError(
              "token_transfer_from_mismatch",
              "A token transfer would move a balance other than this account's own."
            );
          }
          if (op.args[1] !== tokenTransfer.destination) {
            throw new VerificationError(
              "transfer_destination_mismatch",
              "A token transfer would send the balance to an address you did not choose."
            );
          }
          const exchange = expected.depositAddresses[tokenTransfer.destination];
          if (exchange !== undefined) {
            throw new VerificationError(
              "transfer_to_deposit_address",
              `A token transfer would send the balance to a ${exchange} deposit address. A token transfer carries no deposit memo, so ${exchange} could not credit it. Go back to the plan and choose a wallet you control.`
            );
          }
          const amount = op.args[2] ?? "";
          if (
            !/^\d+$/.test(amount) ||
            !/^\d+$/.test(tokenTransfer.amount) ||
            BigInt(amount) < BigInt(tokenTransfer.amount)
          ) {
            throw new VerificationError(
              "transfer_amount_short",
              "A token transfer would send less than the balance you were shown. If you moved " +
                "some of this token since, run the analysis again."
            );
          }
          if (op.authorizesBeyondSelf || op.authDepth !== 0) {
            throw new VerificationError(
              "invocation_auth_beyond_self",
              "A token transfer would authorize actions beyond the transfer itself."
            );
          }
          if (op.unsupportedAddressCount > 0) {
            throw new VerificationError(
              "invocation_address_unsupported",
              "A token transfer names an address form that cannot be verified."
            );
          }
          for (const account of op.accountsReferenced) {
            if (account !== expected.source && account !== tokenTransfer.destination) {
              throw new VerificationError(
                "invocation_foreign_account",
                "A token transfer names an account other than this one and your chosen destination."
              );
            }
          }
          for (const contract of op.contractsReferenced) {
            if (contract !== op.contract) {
              throw new VerificationError(
                "token_transfer_foreign_contract",
                "A token transfer would reach a contract other than the token itself."
              );
            }
          }
          break;
        }
        // A DeFi exit: a Soroban contract call the API built. The client cannot know a protocol's
        // ABI, so the check pins the call to what the client can vouch for on its own, from the
        // account read the user reviewed: the call must be the transaction's only operation (a
        // Soroban call cannot share one with classic ops, so anything alongside it is foreign);
        // it must act as the account being closed; it may invoke only a contract the analysis
        // showed this account holds a position in, or the bundled registry's router for that
        // protocol; every account it names - in its arguments and in the whole authorization tree
        // the signature will satisfy, nested calls included - must be that same account; every
        // contract it names must be one of those positions, the token contract of an asset the
        // account holds, or a token of one of those positions; and the signature may authorize
        // nothing beyond the account's own plain calls. What this does NOT check is the amount
        // or the protocol-level meaning of the call - that is the runner's job on the API and is
        // the residual trust documented in architecture.md §13.
        if (intent.operations.length !== 1) {
          throw new VerificationError(
            "invocation_not_alone",
            "A DeFi exit must be the only operation in its transaction."
          );
        }
        if (BigInt(intent.fee) > MAX_EXIT_FEE_STROOPS) {
          throw new VerificationError(
            "fee_above_cap",
            "A DeFi exit would pay a network fee far above what any exit needs."
          );
        }
        if (op.source !== expected.source) {
          throw new VerificationError(
            "operation_source_mismatch",
            "A DeFi exit would act for an account other than the one being closed."
          );
        }
        if (!expected.exitContracts.includes(op.contract)) {
          throw new VerificationError(
            "exit_contract_not_position",
            "A DeFi exit would call a contract that is not one of this account's detected positions."
          );
        }
        // A share or debt token is the position's own token: a pool's receipt for its shares, a
        // vault's stablecoin. The account read names it, and naming it admits it to the lists
        // below, so a read that points one at an asset the account holds for value (XLM, a
        // classic asset, or, for a share token, a Soroban balance the read lists, which discovery
        // never reports for a share token) would let an exit move that asset as if it were the
        // position's. A debt token may be a listed Soroban balance: it is what a repay spends.
        if (
          expected.shareTokenContracts.some((t) => expected.heldTokenContracts.includes(t)) ||
          expected.debtTokenContracts.some((t) => expected.protectedTokenContracts.includes(t))
        ) {
          throw new VerificationError(
            "exit_expectation_inconsistent",
            "Your analysis names XLM, a classic asset or another token you hold as a DeFi " +
              "position's own share or debt token, which it never is. Run the analysis again."
          );
        }
        if (!(expected.exitFunctions[op.contract] ?? []).includes(op.function)) {
          throw new VerificationError(
            "exit_function_not_allowed",
            "A DeFi exit would call a function LumenWipe does not use to leave this protocol."
          );
        }
        if (op.authorizesBeyondSelf) {
          throw new VerificationError(
            "invocation_auth_beyond_self",
            "A DeFi exit would authorize actions beyond this account's own contract call."
          );
        }
        if (op.unsupportedAddressCount > 0) {
          throw new VerificationError(
            "invocation_address_unsupported",
            "A DeFi exit names an address form that cannot be verified."
          );
        }
        for (const account of op.accountsReferenced) {
          if (account !== expected.source) {
            throw new VerificationError(
              "invocation_foreign_account",
              "A DeFi exit would send funds to, or act for, an account other than the one being closed."
            );
          }
        }
        for (const contract of op.contractsReferenced) {
          if (
            !expected.exitContracts.includes(contract) &&
            !expected.heldTokenContracts.includes(contract) &&
            !expected.positionTokenContracts.includes(contract)
          ) {
            throw new VerificationError(
              "exit_foreign_contract",
              "A DeFi exit would send funds to, or call, a contract this account has no position, balance, or pool token in."
            );
          }
        }
        // The check above pins every contract named in the tree to a known position, balance,
        // or pool token - but says nothing about what a sub-invocation on a token actually does.
        // The top-level call (checked against exitFunctions above) could be a legitimate
        // `withdraw`, while a sub-invocation the same signature authorizes calls `transfer` on a
        // held token with an arbitrary recipient - `accountsReferenced` only catches that
        // recipient when it is a plain account, not a contract. Every sub-invocation on a token
        // this account holds or has a position in is pinned here to a function that only ever
        // moves value to this account or to the contract at the root of this exact invocation -
        // never a third party (issue #208).
        if (op.function === "submit") assertBlendSubmitArguments(op.args, expected.source);
        if (op.function === "remove_liquidity") {
          assertSoroswapRemovalArguments(op.args, expected.source);
        }
        // Blend's `claim(from, ids, to)` and Aquarius's `claim(user)` both pay their last argument.
        if (
          op.function === "claim" &&
          (op.args[0] !== expected.source || op.args[op.args.length - 1] !== expected.source)
        ) {
          throw new VerificationError(
            "exit_argument_party_mismatch",
            "A DeFi exit would act for, or pay, an address other than the account being closed."
          );
        }
        // A position's contract comes from the account read. A contract the bundled registry does
        // not name may touch only that position's own tokens, and never XLM or a classic asset the
        // read lists.
        if (!expected.registryContracts.includes(op.contract)) {
          const own = expected.ownTokensByContract[op.contract] ?? [];
          for (const sub of op.subInvocations) {
            const isAccountToken =
              expected.protectedTokenContracts.includes(sub.contract) ||
              expected.heldTokenContracts.includes(sub.contract) ||
              expected.positionTokenContracts.includes(sub.contract);
            if (
              expected.protectedTokenContracts.includes(sub.contract) ||
              (isAccountToken && !own.includes(sub.contract))
            ) {
              throw new VerificationError(
                "exit_unverified_spend",
                "A DeFi exit would spend your XLM, a classic asset or another token through a " +
                  "contract LumenWipe has not verified."
              );
            }
          }
        } else {
          const repayable = expected.repayTokensByPool[op.contract] ?? [];
          for (const sub of op.subInvocations) {
            if (!expected.protectedTokenContracts.includes(sub.contract)) continue;
            const repaysThisPool =
              repayable.includes(sub.contract) &&
              sub.function === "transfer" &&
              sub.args.length === 3 &&
              sub.args[0] === expected.source &&
              sub.args[1] === op.contract;
            if (!repaysThisPool) {
              throw new VerificationError(
                "exit_spend_not_repay",
                "This exit would spend your XLM or a classic asset other than to repay a debt in " +
                  "your analysis. If this position changed since, run the analysis again."
              );
            }
          }
        }
        for (const sub of op.subInvocations) {
          // An LP share lives in the Soroswap pair's own contract, which has no exit call of its
          // own. The router pays exactly the removed amount into that pair, and authorizes nothing else.
          if (op.function === "remove_liquidity") {
            const paysShareIntoPair =
              op.subInvocations.length === 1 &&
              expected.exitFunctions[sub.contract]?.length === 0 &&
              sub.function === "transfer" &&
              sub.args.length === 3 &&
              sub.args[0] === expected.source &&
              sub.args[1] === sub.contract &&
              sub.args[2] === op.args[2];
            if (!paysShareIntoPair) {
              throw new VerificationError(
                "exit_liquidity_auth_invalid",
                "A DeFi exit would authorize something other than paying its liquidity share into its pair."
              );
            }
            continue;
          }
          const isToken =
            expected.heldTokenContracts.includes(sub.contract) ||
            expected.positionTokenContracts.includes(sub.contract);
          if (!isToken) {
            throw new VerificationError(
              "exit_auth_foreign_contract",
              "A DeFi exit would authorize a call on a contract that is not one of this account's tokens."
            );
          }
          const shape = TOKEN_SUB_INVOCATION_FUNCTIONS[sub.function];
          if (shape === undefined) {
            throw new VerificationError(
              "exit_token_function_not_allowed",
              "A DeFi exit would call a function on a token that LumenWipe does not use to leave a protocol."
            );
          }
          // A mismatched argument count cannot be this function's real SEP-41 signature - reject
          // before trusting `args[recipientArg]` as the recipient, the same way the existing
          // plain-transfer branch checks `args.length !== 3` before indexing into it.
          if (sub.args.length !== shape.argCount) {
            throw new VerificationError(
              "exit_token_argument_count",
              "A DeFi exit would call a token function with an argument count that does not match its real signature."
            );
          }
          if (
            shape.recipientArg >= 0 &&
            sub.args[shape.recipientArg] !== expected.source &&
            sub.args[shape.recipientArg] !== op.contract
          ) {
            throw new VerificationError(
              "exit_token_recipient_mismatch",
              "A DeFi exit would move a token balance to an address other than this account or the protocol it is exiting."
            );
          }
        }
        break;
      }
      // Stryker disable next-line StringLiteral: disabling this case label sends an "unknown"
      // op to the exhaustiveness-guard `default` below, which throws the exact same message -
      // the two branches are textually identical on purpose (see that guard's comment), so this
      // mutation is unobservable by design, not a gap.
      case "unknown":
        // normalizeOp preserves any unrecognized operation as `unknown` so it cannot be
        // silently dropped; verification refuses to sign a transaction that carries one.
        throw new VerificationError(
          "operation_unknown",
          "The transaction contains an unrecognized operation."
        );
      // Stryker disable next-line ConditionalExpression: this case's entire body is a no-op
      // `break` (see the comment below for why revoke_sponsorship needs no check). Collapsing it
      // just falls through to the next case, which is also a no-op `break` - unobservable either
      // way.
      case "revoke_sponsorship":
        // CAP-33: RevokeSponsorship always reverts the entry's reserve burden to its own
        // owning account UNLESS the operation's source account is sandwiched inside a
        // BeginSponsoringFutureReserves/EndSponsoringFutureReserves bracket, which would
        // instead transfer it to a new sponsor. normalizeOp never recognizes those two op
        // types (by design - see the case list in intent/serialize.ts), so any transaction
        // containing one already fails at the `case "unknown"` branch above before reaching
        // here, wherever in the operation list it sits. That is the entire safety guarantee
        // for this op family: it structurally cannot redirect reserve to a third party once
        // sponsorship-transfer brackets are unreachable. The op itself carries no field that
        // could name a beneficiary, so there is nothing further to check here.
        break;
      case "account_merge":
      case "claim_claimable_balance":
        break;
      default: {
        // Exhaustiveness guard, deliberately fail-closed. Adding a member to IntentOperation
        // without also deciding here how verification treats it is a compile error, not a
        // silent pass: this switch is the allowlist CLAUDE.md requires every new close
        // operation to be added to alongside the API's builder. At runtime it is unreachable
        // (normalizeOp maps anything it does not recognize to `unknown`), so it doubles as a
        // backstop for an intent that reached here from some other producer.
        const _exhaustive: never = op;
        throw new VerificationError(
          "operation_unknown",
          "The transaction contains an unrecognized operation."
        );
      }
    }
    // A signature covers every operation whose source lists the key, so each operation is held to
    // the account being closed. The forward is the exception: `assertMergeShape` pins its source
    // to the account the merge paid into.
    if (op !== forward && op.source !== expected.source) {
      throw new VerificationError(
        "operation_source_mismatch",
        "The transaction would act for an account other than the one being closed."
      );
    }
  }

  assertMemo(intent, expected);
}

const MEMO_TYPE_WITH_ARTICLE: Record<"text" | "id" | "hash", string> = {
  text: "a text",
  id: "an id",
  hash: "a hash",
};

/**
 * The memo is bound to the transaction that delivers the balance: the merge to the destination,
 * or the mediated merge and forward. That transaction carries exactly the memo the user confirmed,
 * value and type, or none when they set none. Every other transaction of a close carries no memo:
 * the API never puts one there, and a per-asset transfer cannot carry a memo of its own.
 *
 * The type is compared as well as the value because the decoded value alone cannot tell them
 * apart: an id memo 4411 and a text memo "4411" read back as the same string, and a wallet that
 * credits deposits by id does not credit a text memo.
 */
function assertMemo(intent: TxIntent, expected: CloseExpectation): void {
  // A memo of any kind counts: a value of a type the intent does not name (a return memo), and a
  // type with no value.
  const carriesMemo = intent.memo !== null || intent.memoType !== null;
  const deliversBalance = intent.guarantees.mergeDestination !== null;

  if (!deliversBalance || expected.memo === null) {
    if (carriesMemo) {
      throw new VerificationError(
        "memo_unexpected",
        "The transaction carries a memo you did not set."
      );
    }
  } else {
    if (expected.memoType === null) {
      throw new VerificationError(
        "memo_type_unreadable",
        "The memo type you confirmed could not be read, so this close cannot be checked."
      );
    }
    if (!carriesMemo) {
      throw new VerificationError("memo_missing", "The transaction is missing the memo you set.");
    }
    if (intent.memo !== expected.memo) {
      throw new VerificationError(
        "memo_value_mismatch",
        "The transaction carries a memo you did not set."
      );
    }
    if (intent.memoType !== expected.memoType) {
      const sent =
        intent.memoType === null ? "an unreadable" : MEMO_TYPE_WITH_ARTICLE[intent.memoType];
      throw new VerificationError(
        "memo_type_mismatch",
        `The transaction would send your memo as ${sent} memo, not the ${expected.memoType} memo you confirmed.`
      );
    }
  }

  // A destination that needs a memo is never paid without one. Only the transaction that
  // delivers the balance can carry a memo, so a payment to it anywhere else is refused here too.
  const paysDestination =
    intent.guarantees.mergeDestination === expected.destination ||
    intent.guarantees.paymentsOnlyTo.includes(expected.destination);
  if (paysDestination && expected.memoRequired && (!deliversBalance || expected.memo === null)) {
    throw new VerificationError("memo_required", "This destination requires a deposit memo.");
  }
}

function depositAddressesOf(
  transfers: { destination: string }[],
  lookup: (address: string) => RegistryEntry | null
): Record<string, string> {
  const listed: Record<string, string> = {};
  for (const { destination } of transfers) {
    const exchange = lookup(destination);
    if (exchange) listed[destination] = exchange.name;
  }
  return listed;
}

/** A served exchange registry payload, as `GET /v1/config/exchange-registry` returns it. Only these
 *  fields are read, and none is trusted: every one is shape-checked and merged stricter-only. */
export interface ServedRegistryInput {
  entries: RegistryEntry[];
  lastVerified: string;
  validUntil: string;
}

/** The exchange registry one verification reads on one network: its entries, whether it is still
 *  usable, and whether the served copy disputes an address's bundled memo type. */
interface RegistryView {
  lookup: (address: string) => RegistryEntry | null;
  usable: () => boolean;
  memoTypeInDispute: (address: string) => boolean;
}

/**
 * The registry for one call. With no snapshot, the one the web holds in module state, exactly as
 * before. With one, that snapshot merged over the bundled copy, never over module state, so a
 * call depends on its arguments alone. A snapshot that is not a registry at all is refused: the
 * caller asked for it to be applied, and quietly verifying without it would check a newly listed
 * exchange as a plain wallet.
 *
 * The mediated hand-off is not part of the view. It stays decided by the bundled copy alone
 * (`mediatorAllowedFor`): enabling it from served data would let the party that builds the
 * transaction and reports the balance also choose which closes may route through an
 * intermediary it names.
 */
function registryView(served: ServedRegistryInput | undefined, network: Network): RegistryView {
  if (served === undefined) {
    return {
      lookup: (address) => lookupExchange(address, network),
      usable: () => isRegistryUsable(),
      memoTypeInDispute,
    };
  }
  const merged = mergeServedRegistry(bundledRegistry(), served);
  if (merged === null) {
    throw new VerificationError(
      "registry_snapshot_invalid",
      "The exchange registry passed to the verifier is not a registry (it needs an entries list, " +
        "lastVerified and validUntil), so this close cannot be checked against it."
    );
  }
  const byAddress = new Map(
    merged.entries.filter((e) => appliesOn(e, network)).map((e) => [e.address, e])
  );
  const disputes = new Set(merged.memoTypeDisputes);
  return {
    lookup: (address) => byAddress.get(address) ?? null,
    usable: () => isUsableAt(merged.validUntil, new Date()),
    memoTypeInDispute: (address) => disputes.has(address),
  };
}

/**
 * The memo type a close to a listed exchange is held to, or a refusal when the sources disagree.
 *
 * A memo sent under the wrong type reaches the exchange's address and is credited to nobody, and
 * the served registry is not authenticated, so it never decides the type on its own:
 * - for an exchange the bundled copy lists, the bundled type stands, and a served copy that gives
 *   another one stops the close: one of the two is out of date and nothing here says which;
 * - for an address only the served copy lists, the type the user confirmed stands, and a served
 *   type that differs from it stops the close rather than replacing it.
 */
function listedMemoType(
  exchange: RegistryEntry,
  registry: RegistryView,
  network: Network,
  expected: { destination: string; memo: string | null; memoType: "text" | "id" | "hash" | null }
): "text" | "id" | "hash" | null {
  if (registry.memoTypeInDispute(expected.destination)) {
    throw new VerificationError(
      "registry_memo_type_conflict",
      `The served exchange registry gives ${exchange.name} a different memo type than the ` +
        "bundled one, so the memo this close needs cannot be checked."
    );
  }
  if (bundledExchange(expected.destination, network) !== null) return exchange.memoType;
  if (
    expected.memo !== null &&
    expected.memoType !== null &&
    expected.memoType !== exchange.memoType
  ) {
    throw new VerificationError(
      "registry_memo_type_unconfirmed",
      `The served exchange registry lists ${exchange.name} with ${MEMO_TYPE_WITH_ARTICLE[exchange.memoType]} ` +
        `memo, not the ${expected.memoType} memo you confirmed.`
    );
  }
  return expected.memoType;
}

/**
 * Decodes a server-built unsigned close transaction and asserts it against what the client
 * expects, using the client-bundled exchange registry for the memo policy. Throws on any
 * mismatch; the browser must only sign after this returns. Run once per transaction, before
 * each sign. Fully client-side: safety follows from the transaction's own structure, so no
 * on-chain read is needed (an over-stated amount or a stale build simply fails on submission).
 */
export function verifyCloseTransaction(opts: {
  unsignedXdr: string;
  network: Network;
  preAuthorized?: boolean;
  /** A served exchange registry to apply over the bundled one, stricter-only. Omitted, the
   *  registry the web holds is read. */
  servedRegistry?: ServedRegistryInput;
  expected: {
    source: string;
    destination: string;
    nativeBalance: string;
    memo: string | null;
    /** The type the user confirmed for `memo` (`confirmedMemo`), or null with no memo. The
     *  bundled registry's type replaces it for an exchange the bundle lists; a served registry's
     *  type that differs from it is refused, never adopted. */
    memoType: "text" | "id" | "hash" | null;
    claimTrustlineAssets: string[];
    accountSigners: AccountSigner[];
    accountThresholds: AccountThresholds;
    /** The per-asset transfers the user chose. Required, not optional with a `{}` default: a
     *  caller that forgets to pass them would have every transfer payment rejected, which is
     *  safe, but a caller that means to allow them must say so explicitly rather than inherit
     *  it. */
    transfers: Record<string, { destination: string; amount: string }>;
    tokenTransfers: Record<string, { destination: string; amount: string }>;
    classicConversions: Record<string, { minAmountOut: string | null }>;
    tokenConversions: Record<
      string,
      { minAmountOut: string; amountOut?: string; amountIn: string; resolvedPath?: string[] }
    >;
    exitContracts: string[];
    heldTokenContracts: string[];
    positionTokenContracts: string[];
    exitFunctions: Record<string, string[]>;
    conversionContracts: string[];
    xlmContract: string;
    registryContracts: string[];
    protectedTokenContracts: string[];
    xbullAssets: Record<string, string>;
    ownTokensByContract: Record<string, string[]>;
    repayTokensByPool: Record<string, string[]>;
    shareTokenContracts: string[];
    debtTokenContracts: string[];
  };
}): void {
  const intent = intentFromXdr(opts.unsignedXdr, NETWORK_PASSPHRASES[opts.network]);
  const registry = registryView(opts.servedRegistry, opts.network);
  const exchange = registry.lookup(opts.expected.destination);

  // Asserted here, not only in the UI. The plan view disables its button on an expired
  // registry, but that is a boolean feeding a control - it does not survive a refactor, a new
  // retry path, or the later rounds of a multi-round close, none of which pass through it
  // again. This is the last thing that runs before a signature, so the invariant belongs here:
  // an exchange close on memo rules nobody has re-checked succeeds on-chain and is credited to
  // nobody.
  if (exchange !== null && !registry.usable()) {
    throw new VerificationError(
      "registry_expired",
      "The exchange deposit rules have expired and have not been re-verified, so this close " +
        "cannot be checked. Refresh the page; if it persists, the registry needs updating."
    );
  }
  // Both routing values come from the registry the browser holds, never from the caller: a
  // close that needs the intermediary must use it whatever the session or the store says.
  assertCloseIntent(intent, {
    ...opts.expected,
    depositAddresses: depositAddressesOf(
      [...Object.values(opts.expected.transfers), ...Object.values(opts.expected.tokenTransfers)],
      registry.lookup
    ),
    // From the bundled copy alone, whatever was served: see `registryView`.
    mediatorRequired: mediatorAllowedFor(opts.expected.destination, opts.network),
    directMergeRefused: exchange?.requiresMediator ?? false,
    memoRequired: exchange?.requiresMemo ?? false,
    memoType:
      exchange === null
        ? opts.expected.memoType
        : listedMemoType(exchange, registry, opts.network, opts.expected),
    nowSeconds: Math.floor(Date.now() / 1000),
    preAuthorized: opts.preAuthorized === true,
  });
}
