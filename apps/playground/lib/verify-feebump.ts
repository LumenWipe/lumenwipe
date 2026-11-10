import "server-only";
import {
  FeeBumpTransaction,
  Keypair,
  Networks,
  StrKey,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { MAX_SPONSORED_FEE_STROOPS } from "./fee-policy";
import { PlaygroundVerificationError } from "./verify";

// The check on the envelope the API's fee sponsor returns, before the playground submits it. The
// inner transaction is the one the playground already verified and signed (lib/verify.ts); the
// sponsor may only wrap it. Every expected value comes from the playground's own configuration and
// its own signed transaction, never from the response.

/** The fee account the API's sponsor signs with, from this deployment's configuration. */
export const EXPECTED_FEE_ACCOUNT_ENV = "PLAYGROUND_EXPECTED_FEE_ACCOUNT_TESTNET";

/** A configured fee account: a valid account public key, or null for anything else. */
export function parseExpectedFeeAccount(raw: string | undefined): string | null {
  const value = raw?.trim() ?? "";
  return StrKey.isValidEd25519PublicKey(value) ? value : null;
}

/** The fee account this deployment expects the sponsor to pay from, read on each request. */
export function expectedFeeAccount(): string | null {
  return parseExpectedFeeAccount(process.env[EXPECTED_FEE_ACCOUNT_ENV]);
}

export interface SponsoredEnvelopeExpectation {
  /** The configured fee account. */
  feeAccount: string;
  /** The hash of the transaction the playground verified and signed. */
  approvedHash: string;
  /** How many signatures the playground's signed transaction carried. */
  signatureCount: number;
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

/**
 * Holds the sponsor's response to the transaction the playground signed: a fee-bump envelope whose
 * fee source is the configured fee account, signed by it, around exactly that transaction with
 * every signature it carried, for no more than the API's own sponsor ceiling. Returns nothing;
 * throws a `PlaygroundVerificationError` on the first rule broken.
 */
export function assertSponsoredEnvelope(
  envelopeXdr: string,
  expected: SponsoredEnvelopeExpectation
): void {
  let parsed: ReturnType<typeof TransactionBuilder.fromXDR>;
  try {
    parsed = TransactionBuilder.fromXDR(envelopeXdr, Networks.TESTNET);
  } catch {
    throw new PlaygroundVerificationError("sponsored_envelope_unreadable");
  }
  if (!(parsed instanceof FeeBumpTransaction)) {
    throw new PlaygroundVerificationError("sponsored_envelope_not_fee_bump");
  }
  if (parsed.feeSource !== expected.feeAccount) {
    throw new PlaygroundVerificationError("sponsored_fee_source_unexpected");
  }
  const inner = parsed.innerTransaction;
  if (hex(inner.hash()) !== expected.approvedHash) {
    throw new PlaygroundVerificationError("sponsored_inner_not_approved");
  }
  if (inner.signatures.length < expected.signatureCount) {
    throw new PlaygroundVerificationError("sponsored_signature_dropped");
  }
  const feeSource = Keypair.fromPublicKey(expected.feeAccount);
  const outerHash = parsed.hash();
  const signed = parsed.signatures.some((s) => feeSource.verify(outerHash, s.signature));
  if (!signed) throw new PlaygroundVerificationError("sponsored_envelope_unsigned");
  if (!/^\d+$/.test(parsed.fee) || BigInt(parsed.fee) > MAX_SPONSORED_FEE_STROOPS) {
    throw new PlaygroundVerificationError("sponsored_fee_above_ceiling");
  }
}
