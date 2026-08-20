import { TransactionBuilder, Transaction, Networks, Operation } from "@stellar/stellar-sdk";
import type { CloseTransaction } from "@lumenwipe/sdk";

// Structural check the playground's backend runs on every XDR the real API
// returns before signing it - defense in depth. The playground's "user" is a
// fixed, backend-owned sink account (never a real, arbitrary address), so this
// allowlist is intentionally narrower than apps/web/lib/stellar/verify.ts,
// which has to validate against an arbitrary user-typed destination.

const ALLOWED_OP_TYPES = new Set([
  "accountMerge",
  "payment",
  "pathPaymentStrictSend",
  "changeTrust",
  "manageSellOffer",
  "manageData",
  "setOptions",
  "claimClaimableBalance",
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

    if (op.type === "accountMerge" && op.destination !== expected.sinkPublic) {
      throw new PlaygroundVerificationError("merge_destination_not_allowed");
    }
    if (
      (op.type === "payment" || op.type === "pathPaymentStrictSend") &&
      op.destination !== expected.sinkPublic
    ) {
      throw new PlaygroundVerificationError("payment_destination_not_allowed");
    }
    if (op.type === "setOptions") {
      const so = op as Operation.SetOptions;
      if (so.signer && so.signer.weight !== 0) {
        throw new PlaygroundVerificationError("setOptions_must_only_remove_signers");
      }
    }
  }
}
