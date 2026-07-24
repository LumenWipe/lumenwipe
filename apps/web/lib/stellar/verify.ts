import { NETWORK_PASSPHRASES, type Network } from "@/config/networks";
import { lookupExchange } from "@/lib/exchange-registry";
import { intentFromXdr } from "@/lib/stellar/intent/serialize";
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
}

/**
 * Asserts a decoded close-transaction intent against what the client independently expects,
 * before the browser signs it. Pure: no network, no XDR decoding, no dependency on the wrapper.
 * This is the trust anchor of the non-custodial model once the API builds transactions
 * server-side — an irreversible account merge must never move funds anywhere the user did not
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
        // The close only removes trustlines (limit 0, however the amount decodes).
        if (Number(op.limit) !== 0) {
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
        // Signer normalization may only remove signers, never add/empower one or disable the
        // master key, and only lowers thresholds (normalization sets them to 0/1/1).
        if (op.signerWeight !== null && op.signerWeight !== 0) {
          throw new VerificationError("A signer would be added or empowered.");
        }
        if (op.masterWeight === 0) {
          throw new VerificationError("The master key would be disabled.");
        }
        if ((op.lowThreshold ?? 0) > 1 || (op.medThreshold ?? 0) > 1 || (op.highThreshold ?? 0) > 1) {
          throw new VerificationError("Account thresholds would be raised.");
        }
        break;
      case "unknown":
        // normalizeOp preserves any unrecognized operation as `unknown` so it cannot be
        // silently dropped; verification refuses to sign a transaction that carries one.
        throw new VerificationError("The transaction contains an unrecognized operation.");
      case "account_merge":
      case "claim_claimable_balance":
        break;
      default:
        break;
    }
  }

  // Memo integrity: the transaction must never carry a memo other than the one the user set.
  if (intent.memo !== null && intent.memo !== expected.memo) {
    throw new VerificationError("The transaction carries a memo you did not set.");
  }

  // Required memo: the transaction delivering funds to the destination must carry the exact
  // memo — value and type — the destination requires.
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
  expected: { source: string; destination: string; mediator: string | null; memo: string | null };
}): void {
  const intent = intentFromXdr(opts.unsignedXdr, NETWORK_PASSPHRASES[opts.network]);
  const exchange = lookupExchange(opts.expected.destination);
  assertCloseIntent(intent, {
    ...opts.expected,
    memoRequired: exchange?.requiresMemo ?? false,
    memoType: exchange?.memoType ?? null,
  });
}
