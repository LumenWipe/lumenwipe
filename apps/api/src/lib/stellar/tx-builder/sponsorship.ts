import { Operation, StrKey, xdr } from "@stellar/stellar-sdk";
import type { SponsoredEntry } from "@lumenwipe/types";
import { assetToSdkAsset } from "@/lib/utils/assets";

// Dispatches by StrKey prefix/decode success, exactly like signers.ts's signerRemovalOp -
// SponsoredEntry only carries the raw key string (no separate `type` field), so the type
// must be inferred the same way an inbound StrKey address is classified anywhere else in
// this codebase. Returns null (never throws) for a key type the SDK can't build a revoke
// op for, matching signerRemovalOp's "skip, don't fail the batch" precedent.
function revokeSignerSponsorshipOp(owner: string, signerKey: string): xdr.Operation | null {
  if (StrKey.isValidEd25519PublicKey(signerKey)) {
    return Operation.revokeSignerSponsorship({
      account: owner,
      signer: { ed25519PublicKey: signerKey },
    });
  }
  if (StrKey.isValidSignedPayload(signerKey)) {
    return Operation.revokeSignerSponsorship({
      account: owner,
      signer: { ed25519SignedPayload: signerKey },
    });
  }
  try {
    return Operation.revokeSignerSponsorship({
      account: owner,
      signer: { preAuthTx: StrKey.decodePreAuthTx(signerKey) },
    });
  } catch {
    // not a preAuthTx key
  }
  try {
    return Operation.revokeSignerSponsorship({
      account: owner,
      signer: { sha256Hash: StrKey.decodeSha256Hash(signerKey) },
    });
  } catch {
    // not a sha256Hash key either - unrecognized type
  }
  return null;
}

/**
 * Builds one Operation.revoke*Sponsorship per entry, transferring each entry's reserve
 * burden back to its own owning account (CAP-33's "stop sponsoring" transition - the only
 * transition this app ever performs; see the trust-anchor note in verify.ts for why no
 * BeginSponsoringFutureReserves bracket ever accompanies these ops).
 *
 * claimable_balance entries are silently skipped: CAP-33 requires a cooperating new sponsor
 * to revoke a claimable balance's sponsorship (REVOKE_SPONSORSHIP_ONLY_TRANSFERABLE otherwise),
 * which this self-service close flow can never arrange. Callers must never route a
 * claimable_balance entry into a REVOKE_SPONSORSHIP step in the first place - it stays a
 * permanent blocker (see tx-builder/index.ts) - but this function stays total and harmless
 * either way rather than throwing on a caller mistake.
 */
export function revokeSponsorshipOps(entries: SponsoredEntry[]): xdr.Operation[] {
  const ops: xdr.Operation[] = [];
  for (const entry of entries) {
    switch (entry.kind) {
      case "account":
        ops.push(Operation.revokeAccountSponsorship({ account: entry.owner }));
        break;
      case "trustline":
        ops.push(
          Operation.revokeTrustlineSponsorship({
            account: entry.owner,
            asset: assetToSdkAsset(entry.asset),
          })
        );
        break;
      case "offer":
        ops.push(Operation.revokeOfferSponsorship({ seller: entry.owner, offerId: entry.offerId }));
        break;
      case "data_entry":
        ops.push(Operation.revokeDataSponsorship({ account: entry.owner, name: entry.name }));
        break;
      case "signer": {
        const op = revokeSignerSponsorshipOp(entry.owner, entry.signerKey);
        if (op) ops.push(op);
        break;
      }
      case "claimable_balance":
        break;
    }
  }
  return ops;
}
