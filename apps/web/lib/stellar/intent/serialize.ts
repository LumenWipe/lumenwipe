import { TransactionBuilder, type Asset, type Transaction } from "@stellar/stellar-sdk";
import type { IntentOperation, TxIntent } from "@/types/close-api";

function assetToString(asset: Asset): string {
  return asset.isNative() ? "native" : `${asset.getCode()}:${asset.getIssuer()}`;
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
        signerWeight: op.signer ? Number(op.signer.weight) : null,
        masterWeight: op.masterWeight == null ? null : Number(op.masterWeight),
        lowThreshold: op.lowThreshold == null ? null : Number(op.lowThreshold),
        medThreshold: op.medThreshold == null ? null : Number(op.medThreshold),
        highThreshold: op.highThreshold == null ? null : Number(op.highThreshold),
      };
    case "claimClaimableBalance":
      return { type: "claim_claimable_balance", balanceId: op.balanceId };
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
