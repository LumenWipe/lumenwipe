import { TransactionBuilder, StrKey, type Asset, type Transaction } from "@stellar/stellar-sdk";
import type { AccountSigner } from "@/types/account";
import type { IntentOperation, TxIntent } from "@/types/close-api";

function assetToString(asset: Asset): string {
  return asset.isNative() ? "native" : `${asset.getCode()}:${asset.getIssuer()}`;
}

type DecodedSetOptions = Extract<Transaction["operations"][number], { type: "setOptions" }>;

// Decodes a SetOptions signer to the same { type, key, weight } shape AccountSigner uses
// elsewhere (apps/web/types/account.ts), so verify() can match it against the
// account's real signer set. The SDK decodes hash(x)/pre-auth-tx signers to raw buffers (unlike
// ed25519 and ed25519-signed-payload, which it already strkey-encodes) - re-encode them so every
// signer type produces a comparable strkey.
function decodeSigner(signer: NonNullable<DecodedSetOptions["signer"]>): AccountSigner {
  if ("ed25519PublicKey" in signer) {
    return {
      type: "ed25519_public_key",
      key: signer.ed25519PublicKey!,
      weight: Number(signer.weight),
    };
  }
  if ("sha256Hash" in signer) {
    const hash = signer.sha256Hash!;
    const hashBuffer = typeof hash === "string" ? Buffer.from(hash, "base64") : hash;
    return {
      type: "hash_x",
      key: StrKey.encodeSha256Hash(hashBuffer),
      weight: Number(signer.weight),
    };
  }
  if ("preAuthTx" in signer) {
    const tx = signer.preAuthTx!;
    const txBuffer = typeof tx === "string" ? Buffer.from(tx, "base64") : tx;
    return {
      type: "preauth_tx",
      key: StrKey.encodePreAuthTx(txBuffer),
      weight: Number(signer.weight),
    };
  }
  return {
    type: "ed25519_signed_payload",
    key: signer.ed25519SignedPayload!,
    weight: Number(signer.weight),
  };
}

// Normalizes a single SDK operation to the safety-critical fields the intent declares.
// Returns null for operation types the close flow never emits, so they cannot smuggle
// effects past verification unnoticed.
function normalizeOp(op: Transaction["operations"][number]): IntentOperation {
  switch (op.type) {
    case "pathPaymentStrictSend":
      return {
        type: "path_payment_strict_send",
        sendAsset: assetToString(op.sendAsset),
        sendAmount: op.sendAmount,
        destination: op.destination,
        destAsset: assetToString(op.destAsset),
        destMin: op.destMin,
        path: op.path.map(assetToString),
      };
    case "payment":
      return {
        type: "payment",
        destination: op.destination,
        asset: assetToString(op.asset),
        amount: op.amount,
      };
    case "changeTrust": {
      const line = op.line;
      const asset = "getCode" in line ? assetToString(line) : `pool:${line.toString()}`;
      return { type: "change_trust", asset, limit: op.limit };
    }
    case "accountMerge":
      return { type: "account_merge", destination: op.destination };
    case "manageSellOffer":
      return { type: "manage_sell_offer", offerId: op.offerId, amount: op.amount };
    case "manageData":
      return {
        type: "manage_data",
        name: op.name,
        value: op.value ? op.value.toString("base64") : null,
      };
    case "setOptions":
      return {
        type: "set_options",
        signer: op.signer ? decodeSigner(op.signer) : null,
        masterWeight: op.masterWeight == null ? null : Number(op.masterWeight),
        lowThreshold: op.lowThreshold == null ? null : Number(op.lowThreshold),
        medThreshold: op.medThreshold == null ? null : Number(op.medThreshold),
        highThreshold: op.highThreshold == null ? null : Number(op.highThreshold),
      };
    case "claimClaimableBalance":
      return { type: "claim_claimable_balance", balanceId: op.balanceId };
    // CAP-33 revoke transitions. Deliberately absent from this list, and required to stay
    // absent: "beginSponsoringFutureReserves" and "endSponsoringFutureReserves". They fall
    // through to `unknown`, which verify.ts rejects outright - and a sponsorship-transfer
    // bracket is the only construct that can point a revoked entry's reserve at an account
    // other than the entry's own owner. Recognizing either would silently unlock that.
    case "revokeAccountSponsorship":
      return { type: "revoke_sponsorship", entryKind: "account", owner: op.account };
    case "revokeTrustlineSponsorship":
      return { type: "revoke_sponsorship", entryKind: "trustline", owner: op.account };
    case "revokeOfferSponsorship":
      return { type: "revoke_sponsorship", entryKind: "offer", owner: op.seller };
    case "revokeDataSponsorship":
      return { type: "revoke_sponsorship", entryKind: "data_entry", owner: op.account };
    case "revokeSignerSponsorship":
      return { type: "revoke_sponsorship", entryKind: "signer", owner: op.account };
    default:
      // Any operation the close vocabulary does not recognize is preserved as `unknown`
      // (not dropped) so verify() can reject a smuggled effect it cannot describe.
      return { type: "unknown" };
  }
}

function sumAmounts(a: string, b: string): string {
  return (Number(a) + Number(b)).toString();
}

// Decodes an unsigned transaction envelope into a structured, verifiable intent.
// Pure: no network access. The future SDK verify() re-runs this and asserts the
// result matches what the API declared before signing.
export function intentFromXdr(xdr: string, networkPassphrase: string): TxIntent {
  const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase) as Transaction;

  const operations = tx.operations.map(normalizeOp);

  const merge = operations.find(
    (o): o is Extract<IntentOperation, { type: "account_merge" }> => o.type === "account_merge"
  );

  const paymentsOnlyTo = [
    ...new Set(
      operations.flatMap((o) =>
        o.type === "payment" || o.type === "path_payment_strict_send" ? [o.destination] : []
      )
    ),
  ];

  const minXlmFromConversions = operations
    .filter(
      (o): o is Extract<IntentOperation, { type: "path_payment_strict_send" }> =>
        o.type === "path_payment_strict_send"
    )
    .reduce<
      string | null
    >((acc, o) => (acc === null ? o.destMin : sumAmounts(acc, o.destMin)), null);

  const memoValue = tx.memo?.value;
  const memoTypeRaw = tx.memo?.type;
  const memoType =
    memoTypeRaw === "text" || memoTypeRaw === "id" || memoTypeRaw === "hash" ? memoTypeRaw : null;

  return {
    summary: "",
    source: tx.source,
    fee: tx.fee,
    memo: memoValue ? memoValue.toString() : null,
    memoType,
    guarantees: {
      mergeDestination: merge ? merge.destination : null,
      paymentsOnlyTo,
      minXlmFromConversions,
    },
    operations,
  };
}
