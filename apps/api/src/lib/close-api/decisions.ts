import type {
  AccountState,
  AssetDisposition,
  ClaimableBalanceSelection,
  DecisionAnswer,
  DecisionPoint,
} from "@lumenwipe/types";

// Stable, URL-safe id for an asset decision: "asset:CODE-ISSUER". The colon in the
// canonical "CODE:ISSUER" asset string is replaced so the id reads cleanly in paths.
export function assetDecisionId(asset: string): string {
  return `asset:${asset.replace(":", "-")}`;
}

// Stable id for a claimable-balance decision: "claim:<balanceId>".
export function claimableBalanceDecisionId(balanceId: string): string {
  return `claim:${balanceId}`;
}

/** True when the account can claim this balance right now: native asset, or an authorized
 *  trustline already exists. Matches the predicate `buildPlan` uses to decide the same thing. */
export function isCurrentlyClaimable(
  asset: string,
  authorizedTrustlineAssets: ReadonlySet<string>
): boolean {
  return asset === "native" || authorizedTrustlineAssets.has(asset);
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
        id: assetDecisionId(tl.asset),
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

// Derives the per-claimable-balance decision the caller must resolve before a close can
// proceed cleanly. A balance the account can already claim (native, or an authorized trustline
// exists) is an opt-out choice, defaulting to "claim" - matching "swap to XLM" defaulting to
// convert. A balance with no authorized trustline forces an explicit choice between adding the
// trustline (then claiming) or forfeiting it - matching "return to issuer" never defaulting.
export function deriveClaimableBalanceDecisionPoints(account: AccountState): DecisionPoint[] {
  const authorizedTrustlineAssets = new Set(
    account.trustlines.filter((tl) => tl.authorized).map((tl) => tl.asset)
  );
  return account.claimableBalances.map((b) => {
    const code = b.asset === "native" ? "XLM" : b.asset.split(":")[0];
    const currentlyClaimable = isCurrentlyClaimable(b.asset, authorizedTrustlineAssets);
    const options = currentlyClaimable
      ? [
          { id: "claim", recommended: true },
          {
            id: "forfeit",
            note: `Leaves ${b.amount} ${code} unclaimed; permanently inaccessible once the account is merged.`,
          },
        ]
      : [
          {
            id: "add_trustline_then_claim",
            note: `Adds a ${code} trustline, then claims the balance.`,
          },
          {
            id: "forfeit",
            note: `Leaves ${b.amount} ${code} unclaimed; permanently inaccessible once the account is merged.`,
          },
        ];
    const ownPredicate =
      b.claimants.find((c) => c.destination === account.address)?.predicate ?? {
        type: "unconditional" as const,
      };
    return {
      id: claimableBalanceDecisionId(b.id),
      type: "claimable_balance" as const,
      subject: {
        kind: "claimable_balance",
        balanceId: b.id,
        asset: b.asset,
        amount: b.amount,
        currentlyClaimable,
        predicate: ownPredicate,
      },
      options,
      // No recommended default when the account cannot yet claim: never silently resolved.
      default: currentlyClaimable ? "claim" : "",
      required: true,
    };
  });
}

// Resolves the caller's answers into a `Record<balanceId, ClaimableBalanceSelection>`. Answers
// whose id does not correspond to a known balance, or whose choice is not a recognized
// selection, are ignored.
export function resolveClaimableBalanceSelections(
  answers: DecisionAnswer[],
  balanceIds: string[]
): Record<string, ClaimableBalanceSelection> {
  const known = new Set(balanceIds);
  const out: Record<string, ClaimableBalanceSelection> = {};
  for (const answer of answers) {
    if (!answer.id.startsWith("claim:")) continue;
    const balanceId = answer.id.slice("claim:".length);
    if (!known.has(balanceId)) continue;
    if (
      answer.choice === "claim" ||
      answer.choice === "add_trustline_then_claim" ||
      answer.choice === "forfeit"
    ) {
      out[balanceId] = answer.choice;
    }
  }
  return out;
}
