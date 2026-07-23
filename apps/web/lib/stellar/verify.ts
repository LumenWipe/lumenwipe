import { TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASES, type Network } from "@/config/networks";
import { getAccountState } from "@/lib/stellar/account";
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
  /** Issuers of the account's live trustlines — the only non-self payment recipients allowed. */
  knownIssuers: readonly string[];
}

/**
 * Asserts a decoded close-transaction intent against what the client independently expects,
 * before the browser signs it. Pure: no network, no XDR decoding. This is the trust anchor
 * of the non-custodial model once the API builds transactions server-side — an irreversible
 * account merge must never move funds anywhere the user did not choose.
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

  // Funds may only be paid to the account itself (conversions), the assets' issuers (returns),
  // and — on the mediator forward — the chosen destination.
  const allowedRecipients = new Set<string>([expected.source, ...expected.knownIssuers]);
  if (expected.mediator !== null) allowedRecipients.add(expected.destination);
  for (const to of intent.guarantees.paymentsOnlyTo) {
    if (!allowedRecipients.has(to)) {
      throw new VerificationError(
        `The transaction would pay funds to an unexpected address (${to}).`
      );
    }
  }

  for (const op of intent.operations) {
    switch (op.type) {
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
        // The close only removes trustlines.
        if (op.limit !== "0") {
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
        // The close only cancels offers.
        if (op.amount !== "0") {
          throw new VerificationError("An offer would be created, not cancelled.");
        }
        break;
      case "set_options":
        // Signer normalization may only remove signers and must never disable the master key.
        if (op.signerWeight !== null && op.signerWeight !== 0) {
          throw new VerificationError("A signer would be added or empowered.");
        }
        if (op.masterWeight === 0) {
          throw new VerificationError("The master key would be disabled.");
        }
        break;
      default:
        break;
    }
  }

  // Memo integrity: the transaction must never carry a memo other than the one the user set.
  if (intent.memo !== null && intent.memo !== expected.memo) {
    throw new VerificationError("The transaction carries a memo you did not set.");
  }
  // Required-memo: the transaction that delivers funds to the destination must carry the memo.
  const deliversToDestination =
    intent.guarantees.mergeDestination === expected.destination ||
    intent.guarantees.paymentsOnlyTo.includes(expected.destination);
  if (deliversToDestination && expected.memoRequired && intent.memo !== expected.memo) {
    throw new VerificationError("This destination requires a deposit memo.");
  }
}

/**
 * Decodes a server-built unsigned close transaction, re-reads live on-chain state, and asserts
 * the transaction against what the client expects. Throws on any mismatch; the browser must
 * only sign after this resolves. Run once per transaction, immediately before each sign.
 */
export async function verifyCloseTransaction(opts: {
  unsignedXdr: string;
  network: Network;
  expected: { source: string; destination: string; mediator: string | null; memo: string | null };
}): Promise<void> {
  const passphrase = NETWORK_PASSPHRASES[opts.network];
  const tx = TransactionBuilder.fromXDR(opts.unsignedXdr, passphrase) as Transaction;
  const intent = intentFromXdr(opts.unsignedXdr, passphrase);

  // Every operation must be one the close vocabulary recognizes; a dropped op means the
  // transaction smuggled an effect the intent cannot describe.
  if (tx.operations.length !== intent.operations.length) {
    throw new VerificationError("The transaction contains an unrecognized operation.");
  }

  const account = await getAccountState(opts.expected.source, opts.network);
  const knownIssuers = account.trustlines.map((t) => t.issuer);
  const memoRequired = lookupExchange(opts.expected.destination)?.requiresMemo ?? false;

  assertCloseIntent(intent, { ...opts.expected, memoRequired, knownIssuers });
}
