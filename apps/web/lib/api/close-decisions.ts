import { assetDecisionId } from "@/lib/close-api/decisions";
import type { AssetDisposition } from "@/types/plan";
import type { DecisionAnswer } from "@/types/close-api";

/**
 * Maps the store's per-asset dispositions (convert to XLM / return to issuer) into the
 * `DecisionAnswer[]` the API's close endpoints expect. The decision id and choice strings
 * must match the API's `deriveDecisionPoints`/`resolveDispositions` contract exactly.
 */
export function dispositionsToDecisions(
  dispositions: Record<string, AssetDisposition>
): DecisionAnswer[] {
  return Object.entries(dispositions).map(([asset, disposition]) => ({
    id: assetDecisionId(asset),
    choice: disposition === "convert" ? "convert_to_xlm" : "return_to_issuer",
  }));
}
