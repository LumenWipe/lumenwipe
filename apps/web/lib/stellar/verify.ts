import { NETWORK_PASSPHRASES, type Network } from "@/config/networks";
import { lookupExchange } from "@/lib/exchange-registry";
import { intentFromXdr } from "@/lib/stellar/intent/serialize";
import type { AccountSigner, AccountThresholds } from "@/types/account";
import type { TxIntent } from "@/types/close-api";

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
  /** The mediator public key for an exchange flow, or null for a direct destination. */
  mediator: string | null;
  /** The memo the user entered, or null. */
  memo: string | null;
  /** Whether the destination requires a memo (from the client-bundled exchange registry). */
  memoRequired: boolean;
  /** The memo type the destination requires (from the registry), or null. */
  memoType: "text" | "id" | "hash" | null;
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
 * Asserts a decoded close-transaction intent against what the client independently expects,
 * before the browser signs it. Pure: no network, no XDR decoding, no dependency on the wrapper.
 * This is the trust anchor of the non-custodial model once the API builds transactions
 * server-side - an irreversible account merge must never move funds anywhere the user did not
 * choose, and no operation may reach signing that verification cannot account for.
 */
export function assertCloseIntent(intent: TxIntent, expected: CloseExpectation): void {
  // The transaction must be for the account being closed.
  if (intent.source !== expected.source) {
    throw new VerificationError("The transaction is not for your account.");
  }

  // The account merge may only target the chosen destination (direct) or the mediator (exchange).
  const allowedMerge = expected.mediator ?? expected.destination;
  if (
    intent.guarantees.mergeDestination !== null &&
    intent.guarantees.mergeDestination !== allowedMerge
  ) {
    throw new VerificationError("The account would be merged to an unexpected destination.");
  }

  for (const op of intent.operations) {
    switch (op.type) {
      case "payment": {
        // A payment is only ever a return-to-issuer (the asset paid back to its own issuer)
        // or, in the mediator flow, the forward of native XLM to the chosen destination.
        const issuer = op.asset.includes(":") ? op.asset.split(":")[1] : null;
        const isIssuerReturn = op.asset !== "native" && issuer === op.destination;
        const isMediatorForward =
          expected.mediator !== null &&
          op.asset === "native" &&
          op.destination === expected.destination;
        if (!isIssuerReturn && !isMediatorForward) {
          throw new VerificationError(
            `The transaction would pay funds to an unexpected address (${op.destination}).`
          );
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
        break;
      case "unknown":
        // normalizeOp preserves any unrecognized operation as `unknown` so it cannot be
        // silently dropped; verification refuses to sign a transaction that carries one.
        throw new VerificationError("The transaction contains an unrecognized operation.");
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
    mediator: string | null;
    memo: string | null;
    claimTrustlineAssets: string[];
    accountSigners: AccountSigner[];
    accountThresholds: AccountThresholds;
  };
}): void {
  const intent = intentFromXdr(opts.unsignedXdr, NETWORK_PASSPHRASES[opts.network]);
  const exchange = lookupExchange(opts.expected.destination);
  assertCloseIntent(intent, {
    ...opts.expected,
    memoRequired: exchange?.requiresMemo ?? false,
    memoType: exchange?.memoType ?? null,
  });
}
