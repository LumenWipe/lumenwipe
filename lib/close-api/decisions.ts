import type { AccountState } from "@/types/account";
import type { AssetDisposition } from "@/types/plan";
import type { DecisionAnswer, DecisionPoint } from "@/types/close-api";

// Stable, URL-safe id for an asset decision: "asset:CODE-ISSUER". The colon in the
// canonical "CODE:ISSUER" asset string is replaced so the id reads cleanly in paths.
function decisionId(asset: string): string {
  return `asset:${asset.replace(":", "-")}`;
}

// Derives the per-asset disposition decisions the caller must resolve before a close
// can be built. `convertibility[asset]` is the best-effort result of path finding:
// true when a DEX route to XLM exists, false otherwise. Only trustlines holding a
// balance need a decision; empty trustlines are simply removed.
export function deriveDecisionPoints(
  account: AccountState,
  convertibility: Record<string, boolean>
): DecisionPoint[] {
  return account.trustlines
    .filter((tl) => Number(tl.balance) > 0)
    .map((tl) => {
      const convertible = convertibility[tl.asset] ?? false;
      const options = convertible
        ? [
            { id: "convert_to_xlm", recommended: true },
            {
              id: "return_to_issuer",
              note: "Sends the balance back to the issuer; you receive no XLM.",
            },
          ]
        : [
            {
              id: "return_to_issuer",
              note: "No conversion route exists; the balance is returned to the issuer.",
            },
          ];
      return {
        id: decisionId(tl.asset),
        type: "asset_disposition" as const,
        subject: { kind: "trustline", asset: tl.asset, balance: tl.balance, convertible },
        options,
        default: convertible ? "convert_to_xlm" : "return_to_issuer",
        required: true,
      };
    });
}

// Resolves the caller's answers into the `assetDispositions` record that the
// transaction builder consumes (`StepBuildContext.assetDispositions`). Answers whose
// id does not correspond to a known asset are ignored.
export function resolveDispositions(
  answers: DecisionAnswer[],
  assetsById: { id: string; asset: string }[]
): Record<string, AssetDisposition> {
  const assetForId = new Map(assetsById.map((a) => [a.id, a.asset]));
  const out: Record<string, AssetDisposition> = {};
  for (const answer of answers) {
    const asset = assetForId.get(answer.id);
    if (!asset) continue;
    if (answer.choice === "convert_to_xlm") out[asset] = "convert";
    else if (answer.choice === "return_to_issuer") out[asset] = "issuer";
  }
  return out;
}
