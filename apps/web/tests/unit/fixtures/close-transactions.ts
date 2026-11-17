import { Networks } from "@stellar/stellar-sdk";
import type { CloseTransaction, TxIntent } from "@lumenwipe/sdk";

/** An intent that promises nothing; the client derives the one it checks from the XDR. */
export function emptyIntent(): TxIntent {
  return {
    summary: "",
    source: "",
    fee: "0",
    memo: null,
    memoType: null,
    guarantees: { mergeDestination: null, paymentsOnlyTo: [], minXlmFromConversions: null },
    operations: [],
  };
}

/** A testnet transaction of a close round, with no dependency and no validity window. */
export function closeTransaction(
  tx: Pick<CloseTransaction, "id" | "order" | "xdr" | "covers"> & Partial<CloseTransaction>
): CloseTransaction {
  return {
    dependsOn: [],
    networkPassphrase: Networks.TESTNET,
    sourceSequence: "0",
    validUntilLedger: 0,
    intent: emptyIntent(),
    ...tx,
  };
}
