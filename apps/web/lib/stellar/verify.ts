import { NETWORK_PASSPHRASES, type Network } from "@/config/networks";
import { isRegistryUsable, lookupExchange } from "@/lib/exchange-registry";
import { intentFromXdr } from "@/lib/stellar/intent/serialize";
import { xlmToStroops } from "@/lib/utils/amounts";
import type { AccountSigner, AccountThresholds } from "@/types/account";
import type { IntentOperation, TxIntent } from "@/types/close-api";

/** Thrown when a server-built close transaction fails verification. Never sign past this. */
export class VerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerificationError";
  }
}

/** What the client independently knows a close transaction should look like. */
export interface CloseExpectation {
  /** The account being closed. */
  source: string;
  /** The user's chosen final destination. */
  destination: string;
  /** Whether the user's destination routes through the shared intermediary, from the client's
   *  own registry lookup. Without it the two-operation hand-off would be accepted for a close
   *  the user asked to send straight to their own wallet - so a shape that only makes sense
   *  for an exchange would become reachable for everyone. */
  mediatorRequired: boolean;
  /** The account's native balance in XLM as the client last read it. The floor under the
   *  forwarded amount: the intermediary is only a conduit if what leaves it is what arrived. */
  nativeBalance: string;
  /** The memo the user entered, or null. */
  memo: string | null;
  /** Whether the destination requires a memo (from the client-bundled exchange registry). */
  memoRequired: boolean;
  /** The memo type the destination requires (from the registry), or null. */
  memoType: "text" | "id" | "hash" | null;
  /**
   * The per-asset transfers the user chose: the account each balance goes to, and the balance
   * the user was shown for it, keyed by the same canonical `CODE:ISSUER` string.
   *
   * The destination is sourced from the user's own decisions, never from the plan or the
   * transaction under verification. That is the security property that matters here. The
   * amount is the trustline balance from the account read, which comes from the same API that
   * builds the transaction - the same honest caveat `nativeBalance` and `accountSigners` carry
   * above: it catches builder bugs and partial compromise, not an adversary who keeps both
   * sides consistent. Return-to-issuer and the mediated
   * forward are both structurally constrained - the issuer is derivable from the asset, and
   * the forward's destination is the address the user typed - so neither can be redirected.
   * A transfer has neither property: its destination is an arbitrary address, which is exactly
   * the shape of a fund-diversion attack. The only thing separating a legitimate transfer from
   * a diversion is that this map came from the user.
   *
   * The amount is here for the same reason the destination is: binding only the destination
   * would let a transaction pay one stroop to the right account and route the rest elsewhere.
   * It is a floor rather than an exact figure - a claim round can legitimately raise the
   * balance between this read and the build, and paying more to an already-pinned destination
   * is not a loss.
   */
  transfers: Record<string, { destination: string; amount: string }>;
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
    throw new VerificationError("The transaction would merge more than one account.");
  }
  const merge = merges[0]!;

  if (merge.source !== expected.source) {
    throw new VerificationError("The account merge is not sent by the account being closed.");
  }

  // Merging to the address the user typed needs no intermediary and no further shape checks.
  if (merge.destination === expected.destination) return null;

  // The hand-off exists because exchanges cannot be merged into. Accepting it for a close the
  // user routed straight to their own wallet would make an attacker-nominated intermediary
  // reachable for every user, not only the ones closing to an exchange.
  if (!expected.mediatorRequired) {
    throw new VerificationError("The account would be merged to an address you did not choose.");
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
      "The account would be merged to an address you did not choose, and this transaction does not hand the balance straight on to your destination."
    );
  }

  const forward = ops[1]!;

  if (forward.source !== merge.destination) {
    // Without this the intermediary is just an address funds go to. With it, the account that
    // received the balance is the one sending it on, in the same transaction.
    throw new VerificationError(
      "The balance would be handed to one account and forwarded by another. Nothing guarantees the account receiving your funds is the one passing them on."
    );
  }
  if (forward.destination !== expected.destination) {
    throw new VerificationError(
      `The transaction would pay funds to an unexpected address (${forward.destination}).`
    );
  }
  if (forward.asset !== "native") {
    throw new VerificationError("The forwarded balance would not be XLM.");
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
function assertUserChoseThisTransfer(
  op: Extract<IntentOperation, { type: "payment" }>,
  expected: CloseExpectation,
  seen: Set<string>
): void {
  const chosen = expected.transfers[op.asset];
  if (!chosen) {
    throw new VerificationError(
      `The transaction would pay funds to an unexpected address (${op.destination}).`
    );
  }
  if (op.destination !== chosen.destination) {
    throw new VerificationError(
      `The transaction would send ${assetCode(op.asset)} to an address you did not choose.`
    );
  }
  if (seen.has(op.asset)) {
    throw new VerificationError(
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
      `The transaction would send less ${assetCode(op.asset)} than you approved.`
    );
  }
}

/**
 * The code half of a canonical "CODE:ISSUER" asset string, for error messages.
 *
 * No "native" case: this is only ever reached for a payment that is neither an issuer-return
 * nor the mediated forward, and `expected.transfers` is keyed by trustline asset, so XLM cannot
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

export function assertCloseIntent(intent: TxIntent, expected: CloseExpectation): void {
  // The transaction must be for the account being closed.
  if (intent.source !== expected.source) {
    throw new VerificationError("The transaction is not for your account.");
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
            "The transaction would pay funds from an account other than the one being closed."
          );
        }
        // A payment is only ever a return-to-issuer (the asset paid back to its own issuer)
        // or the mediated forward, which `assertMergeShape` has already vouched for.
        // Stryker disable next-line StringLiteral,ConditionalExpression: `issuer` is null/
        // undefined whenever `op.asset` has no ":" - which is always true for "native", the only
        // value that makes `op.asset !== "native"` false. `issuer === op.destination` can then
        // never be true in that case (destination is always a real address, never null or
        // undefined), so neither the ":" split nor the "native" comparison is individually
        // observable: isIssuerReturn is false for a native asset regardless of how either is
        // mutated, because the other term already forces it.
        const issuer = op.asset.includes(":") ? op.asset.split(":")[1] : null;
        // Stryker disable next-line StringLiteral,ConditionalExpression: see above - mutating
        // either the "native" literal or the whole clause only matters when asset === "native",
        // where `issuer` (null/undefined either way) can never equal a real destination address.
        const isIssuerReturn = op.asset !== "native" && issuer === op.destination;
        if (!isIssuerReturn && op !== forward) {
          assertUserChoseThisTransfer(op, expected, seenTransfers);
        }
        break;
      }
      case "path_payment_strict_send":
        // Conversions must swap to XLM into the account itself, with a positive floor.
        if (op.destination !== expected.source) {
          throw new VerificationError("A conversion would send funds out of your account.");
        }
        if (op.destAsset !== "native") {
          throw new VerificationError("A conversion would not settle in XLM.");
        }
        if (!(Number(op.destMin) > 0)) {
          throw new VerificationError("A conversion has no minimum-received floor.");
        }
        break;
      case "change_trust":
        // The close only removes trustlines (limit 0, however the amount decodes) - with one
        // narrow exception: a raised trustline for an asset the user themselves chose to add
        // in order to claim an otherwise-unreachable balance ("add trustline and claim").
        if (Number(op.limit) !== 0 && !expected.claimTrustlineAssets.includes(op.asset)) {
          throw new VerificationError("A trustline would be created or raised, not removed.");
        }
        break;
      case "manage_data":
        // The close only deletes data entries.
        if (op.value !== null) {
          throw new VerificationError("A data entry would be written, not removed.");
        }
        break;
      case "manage_sell_offer":
        // The close only cancels offers (amount 0).
        if (Number(op.amount) !== 0) {
          throw new VerificationError("An offer would be created, not cancelled.");
        }
        break;
      case "set_options":
        // Signer normalization may only remove signers, never add/empower one, and the signer
        // it touches must be one that actually exists on the account - otherwise the op has no
        // legitimate purpose in a close and its presence is unexplained. Never disables the
        // master key, and only lowers thresholds (normalization sets them to 0/1/1).
        if (op.signer !== null) {
          const signer = op.signer;
          if (signer.weight !== 0) {
            throw new VerificationError("A signer would be added or empowered.");
          }
          const touchesKnownSigner = expected.accountSigners.some(
            (s) => s.key === signer.key && s.type === signer.type
          );
          if (!touchesKnownSigner) {
            throw new VerificationError(
              "This transaction touches a signer that wasn't on your account when we last read it. Re-run the analysis and try again."
            );
          }
        }
        if (op.masterWeight === 0) {
          throw new VerificationError("The master key would be disabled.");
        }
        if (
          (op.lowThreshold ?? 0) > 1 ||
          (op.medThreshold ?? 0) > 1 ||
          (op.highThreshold ?? 0) > 1
        ) {
          throw new VerificationError("Account thresholds would be raised.");
        }
        if (
          op.homeDomain !== null ||
          op.setFlags !== null ||
          op.clearFlags !== null ||
          op.inflationDest !== null
        ) {
          throw new VerificationError(
            "This transaction would change account flags, the home domain, or the inflation destination, which a close never legitimately needs to touch."
          );
        }
        break;
      case "invoke_host_function":
        // A DeFi exit. The client cannot know a protocol's ABI, so the check is structural and
        // protocol-blind: the invocation must be the transaction's only operation (a Soroban
        // call cannot share one with classic ops, so anything alongside it is foreign), it must
        // act as the account being closed, and every account its arguments name - the position
        // owner, the spender, the recipient - must be that same account. Proceeds therefore
        // cannot be routed anywhere else, whatever the contract is.
        if (intent.operations.length !== 1) {
          throw new VerificationError("A DeFi exit must be the only operation in its transaction.");
        }
        if (op.source !== expected.source) {
          throw new VerificationError(
            "A DeFi exit would act for an account other than the one being closed."
          );
        }
        for (const account of op.accountsReferenced) {
          if (account !== expected.source) {
            throw new VerificationError(
              "A DeFi exit would send funds to, or act for, an account other than the one being closed."
            );
          }
        }
        break;
      // Stryker disable next-line StringLiteral: disabling this case label sends an "unknown"
      // op to the exhaustiveness-guard `default` below, which throws the exact same message -
      // the two branches are textually identical on purpose (see that guard's comment), so this
      // mutation is unobservable by design, not a gap.
      case "unknown":
        // normalizeOp preserves any unrecognized operation as `unknown` so it cannot be
        // silently dropped; verification refuses to sign a transaction that carries one.
        throw new VerificationError("The transaction contains an unrecognized operation.");
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
        throw new VerificationError("The transaction contains an unrecognized operation.");
      }
    }
  }

  // Memo integrity: the transaction must never carry a memo other than the one the user set.
  if (intent.memo !== null && intent.memo !== expected.memo) {
    throw new VerificationError("The transaction carries a memo you did not set.");
  }

  // Required memo: the transaction delivering funds to the destination must carry the exact
  // memo - value and type - the destination requires.
  const deliversToDestination =
    intent.guarantees.mergeDestination === expected.destination ||
    intent.guarantees.paymentsOnlyTo.includes(expected.destination);
  if (deliversToDestination && expected.memoRequired) {
    // Stryker disable next-line ConditionalExpression: the memo-integrity check above already
    // guarantees, for every path that reaches here, that intent.memo is either null or exactly
    // equal to expected.memo (any other value throws before this point) - so
    // `intent.memo !== expected.memo` can never independently be true here. Only the
    // `=== null` half is reachable; the second is dead by construction, not untested.
    if (intent.memo === null || intent.memo !== expected.memo) {
      throw new VerificationError("This destination requires a deposit memo.");
    }
    if (intent.memoType !== expected.memoType) {
      throw new VerificationError("The deposit memo has the wrong type for this destination.");
    }
  }
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
  expected: {
    source: string;
    destination: string;
    mediatorRequired: boolean;
    nativeBalance: string;
    memo: string | null;
    claimTrustlineAssets: string[];
    accountSigners: AccountSigner[];
    accountThresholds: AccountThresholds;
    /** The per-asset transfers the user chose. Required, not optional with a `{}` default: a
     *  caller that forgets to pass them would have every transfer payment rejected, which is
     *  safe, but a caller that means to allow them must say so explicitly rather than inherit
     *  it. */
    transfers: Record<string, { destination: string; amount: string }>;
  };
}): void {
  const intent = intentFromXdr(opts.unsignedXdr, NETWORK_PASSPHRASES[opts.network]);
  const exchange = lookupExchange(opts.expected.destination);

  // Asserted here, not only in the UI. The plan view disables its button on an expired
  // registry, but that is a boolean feeding a control - it does not survive a refactor, a new
  // retry path, or the later rounds of a multi-round close, none of which pass through it
  // again. This is the last thing that runs before a signature, so the invariant belongs here:
  // an exchange close on memo rules nobody has re-checked succeeds on-chain and is credited to
  // nobody.
  if (exchange !== null && !isRegistryUsable()) {
    throw new VerificationError(
      "The exchange deposit rules have expired and have not been re-verified, so this close " +
        "cannot be checked. Refresh the page; if it persists, the registry needs updating."
    );
  }
  assertCloseIntent(intent, {
    ...opts.expected,
    memoRequired: exchange?.requiresMemo ?? false,
    memoType: exchange?.memoType ?? null,
  });
}
