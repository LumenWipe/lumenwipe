import { TransactionBuilder, Transaction, Networks, Operation } from "@stellar/stellar-sdk";
import type { CloseTransaction } from "@lumenwipe/sdk";

// Structural check the playground's backend runs on every XDR the real API
// returns before signing it - defense in depth. The playground's "user" is a
// fixed, backend-owned sink account (never a real, arbitrary address), so this
// allowlist is intentionally narrower than apps/web/lib/stellar/verify.ts,
// which has to validate against an arbitrary user-typed destination.
//
// Narrower, but the same semantics where they overlap: only the ACCOUNT_MERGE
// pays the sink. A conversion settles into the account being closed and a
// payment goes back to its own asset issuer, so neither is checked against the
// sink at all - checking it against the sink rejects every close the real
// builder can produce.

const ALLOWED_OP_TYPES = new Set([
  "accountMerge",
  "payment",
  "pathPaymentStrictSend",
  "changeTrust",
  "manageSellOffer",
  "manageData",
  "setOptions",
  "claimClaimableBalance",
  // Sponsorship revocation, as the real close builder emits it (apps/api's tx-builder/
  // sponsorship.ts). The SDK's *builder* input type is the single string "revokeSponsorship",
  // but a DECODED operation never carries that: Operation.fromXDRObject expands the union into
  // one concrete type per ledger-entry kind (see the SDK's base/operation.js
  // `extractRevokeSponshipDetails`), so these are the strings that actually reach `op.type`.
  // Only the kinds the builder can emit are listed; a claimable-balance sponsorship can never
  // be self-revoked (CAP-33) and is refused as a blocker upstream.
  "revokeAccountSponsorship",
  "revokeTrustlineSponsorship",
  "revokeOfferSponsorship",
  "revokeDataSponsorship",
  "revokeSignerSponsorship",
]);

export class PlaygroundVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaygroundVerificationError";
  }
}

export interface PlaygroundCloseExpectation {
  demoPublic: string;
  sinkPublic: string;
}

export function verifyDemolishTransaction(
  tx: CloseTransaction,
  expected: PlaygroundCloseExpectation
): void {
  const parsed = TransactionBuilder.fromXDR(tx.xdr, Networks.TESTNET);
  if (!(parsed instanceof Transaction)) {
    throw new PlaygroundVerificationError("fee_bump_not_allowed");
  }

  if (parsed.source !== expected.demoPublic) {
    throw new PlaygroundVerificationError("source_not_allowed");
  }

  for (const op of parsed.operations) {
    if (!ALLOWED_OP_TYPES.has(op.type)) {
      throw new PlaygroundVerificationError(`op_not_allowed:${op.type}`);
    }
    if (op.source && op.source !== expected.demoPublic) {
      throw new PlaygroundVerificationError("op_source_not_allowed");
    }

    // The merge is the only operation that may pay the sink: it is the whole point of the close.
    if (op.type === "accountMerge" && op.destination !== expected.sinkPublic) {
      throw new PlaygroundVerificationError("merge_destination_not_allowed");
    }

    // A conversion swaps a balance to XLM *into the account being closed*, never out of it -
    // `assetConversionOp` in apps/api's tx-builder passes the closing account as `destination`.
    // Mirrors the production rule in apps/web/lib/stellar/verify.ts ("Conversions must swap to
    // XLM into the account itself, with a positive floor").
    if (op.type === "pathPaymentStrictSend") {
      if (op.destination !== expected.demoPublic) {
        throw new PlaygroundVerificationError("conversion_destination_not_allowed");
      }
      if (!op.destAsset.isNative()) {
        throw new PlaygroundVerificationError("conversion_must_settle_in_xlm");
      }
      // A zero floor is not a floor: it would let a conversion settle for nothing.
      if (!(Number(op.destMin) > 0)) {
        throw new PlaygroundVerificationError("conversion_has_no_minimum");
      }
    }

    // A payment in a close is only ever a return-to-issuer: the asset paid back to the very
    // issuer that is encoded in the asset itself, so the destination cannot be redirected
    // (`issuerPaymentOp`). The playground never chooses the `transfer_to_account` disposition,
    // so no other payment shape is legitimate here - and a native payment has no place at all,
    // since the XLM balance leaves via the merge.
    if (op.type === "payment") {
      if (op.asset.isNative()) {
        throw new PlaygroundVerificationError("native_payment_not_allowed");
      }
      if (op.destination !== op.asset.getIssuer()) {
        throw new PlaygroundVerificationError("payment_destination_not_allowed");
      }
    }

    if (op.type === "setOptions") {
      const so = op as Operation.SetOptions;
      if (so.signer && so.signer.weight !== 0) {
        throw new PlaygroundVerificationError("setOptions_must_only_remove_signers");
      }
    }
  }
}
