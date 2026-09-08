import type { Transaction } from "@stellar/stellar-sdk";

/** One parsed operation, exactly as `tx.operations` (the same source mediator.controller.ts
 *  reads) returns it - expressed off that getter rather than a named export, so this always
 *  matches what the SDK actually hands back regardless of its own internal type naming. */
type ParsedOperation = Transaction["operations"][number];

/**
 * Whether every operation in the transaction acts for the same account: the transaction's own
 * source, whether an operation states it explicitly or - Stellar's default - leaves it unstated.
 * Stellar allows each operation to name its own source, so without this a caller could bundle
 * wind-down-shaped operations for several unrelated accounts into one envelope and have all of
 * them pass `isAllowedWindDownOperation` independently, even though nothing about the request
 * describes one account's close. This is what makes "one account's wind-down" actually true of
 * the transaction as a whole, not just of each operation in isolation.
 */
export function actsForOneAccount(tx: Transaction): boolean {
  return tx.operations.every((op) => op.source === undefined || op.source === tx.source);
}

/**
 * The wind-down operation shapes the fee-bump sponsor will pay for (architecture.md §8.1,
 * threat-model.md §6). Every operation in a sponsored transaction must match one of these, or
 * the request is refused before the fee account ever signs anything.
 *
 * This is a spoofing defense, not a full re-derivation of close intent: the destination of an
 * `AccountMerge` or `PathPaymentStrictSend` is not pinned here, because doing so would need this
 * stateless endpoint to know what a specific close session chose - state this endpoint does not
 * have and is not meant to hold. What bounds the risk instead is structural: the fee account's
 * signature only ever authorizes the fee account's own payment of the outer envelope's fee; it
 * cannot substitute for or forge the inner transaction's required signature over its own
 * operations, so nothing sponsored here can move funds the caller does not already control by
 * holding that signature (docs/threat-model.md §6-7). What this function stops is an operation
 * type with no place in a close at all - a Soroban invocation, a data write, an offer placed
 * rather than cancelled - from riding along on the fee account's signature.
 */
export function isAllowedWindDownOperation(op: ParsedOperation): boolean {
  switch (op.type) {
    case "changeTrust":
      // Only removing a trustline (limit 0), never opening or raising one. The SDK renders the
      // parsed limit at 7 decimal places ("0.0000000"), not the bare "0" a builder call takes.
      return parseFloat(op.limit) === 0;
    case "manageSellOffer":
      // Only cancelling an existing offer (amount 0), never placing or resizing one.
      return parseFloat(op.amount) === 0;
    case "manageBuyOffer":
      return parseFloat(op.buyAmount) === 0;
    case "manageData":
      // Only removing a data entry, never writing one.
      return op.value === undefined || op.value === null;
    case "setOptions":
      return isSignerNormalizationOnly(op);
    case "claimClaimableBalance":
    case "pathPaymentStrictSend":
    case "accountMerge":
      return true;
    default:
      return false;
  }
}

/**
 * Whether a `SetOptions` operation is signer normalization and nothing else: it may only lower
 * or remove a signer, never add or empower one; it never disables the master key; it never
 * raises a threshold above the normalized 0/1/1; and it never touches flags, the home domain, or
 * the inflation destination. The same shape `verify()` holds the browser to (apps/web/lib/stellar/
 * verify.ts), minus the "signer must be one the client already knew about" check, which needs
 * account state this stateless endpoint does not have - the fee-bump sponsor is a narrower,
 * structure-only gate layered in front of that stronger, context-aware one.
 */
function isSignerNormalizationOnly(op: Extract<ParsedOperation, { type: "setOptions" }>): boolean {
  // The SDK parses an absent optional field as `null` for some fields and `undefined` for
  // others (a real, observed inconsistency, not a documentation gap this comment is guessing
  // at) - `== null` catches both, so "not present" means the same thing everywhere below.
  if (op.signer != null && op.signer.weight !== 0) return false;
  if (op.masterWeight === 0) return false;
  if ((op.lowThreshold ?? 0) > 1 || (op.medThreshold ?? 0) > 1 || (op.highThreshold ?? 0) > 1) {
    return false;
  }
  if (
    op.homeDomain != null ||
    op.setFlags != null ||
    op.clearFlags != null ||
    op.inflationDest != null
  ) {
    return false;
  }
  return true;
}
