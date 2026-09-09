import type { PlanResponse } from "@lumenwipe/sdk";
import type { PlannedStep } from "@/types/plan";
import type { ClaimPredicate } from "@/types/account";

/**
 * Per-asset convertibility consumed by the analyze UI. Relocated here from the old
 * client-side builder (fast-path) now that the plan comes from the API.
 */
export interface AssetConvertibility {
  /** The classic asset (`CODE:ISSUER`) or, for a Soroban token, its contract id. */
  asset: string;
  code: string;
  /** Human-readable balance: decimal for a classic asset or a token with known decimals. */
  balance: string;
  convertible: boolean;
  /** Present for a Soroban token: its contract and the raw balance verify() holds a transfer to.
   *  `arrivesFromExit`: the balance is what a position's exit will pay out, not what is held now. */
  token?: {
    contract: string;
    symbol: string | null;
    decimals: number | null;
    rawBalance: string;
    arrivesFromExit: boolean;
    /** The plan's conversion quote when a route exists: XLM out and the floor, in stroops. */
    quote?: { amountOut: string; minAmountOut: string; platform: string; route: string[] };
  };
}

function tokenQuoteOf(
  raw: unknown
): { amountOut: string; minAmountOut: string; platform: string; route: string[] } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const q = raw as Record<string, unknown>;
  if (typeof q.amountOut !== "string" || typeof q.minAmountOut !== "string") return undefined;
  if (!/^\d+$/.test(q.amountOut) || !/^[1-9]\d*$/.test(q.minAmountOut)) return undefined;
  return {
    amountOut: q.amountOut,
    minAmountOut: q.minAmountOut,
    platform: typeof q.platform === "string" ? q.platform : "",
    route: Array.isArray(q.route) ? q.route.filter((r): r is string => typeof r === "string") : [],
  };
}

/** Stroops rendered as XLM with the trailing zeros dropped. */
export function formatStroops(stroops: string): string {
  return formatTokenBalance(stroops, 7);
}

/** Base units rendered with the token's decimals; raw units, labelled, when it has none. */
export function formatTokenBalance(rawBalance: string, decimals: number | null): string {
  if (!/^\d+$/.test(rawBalance)) return rawBalance;
  if (decimals === null || !Number.isInteger(decimals) || decimals < 0 || decimals > 38) {
    return `${rawBalance} base units`;
  }
  if (decimals === 0) return rawBalance;
  const padded = rawBalance.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const frac = padded.slice(-decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/**
 * Derives the analyze-page convertibility list from the API plan's asset decision points.
 * The API only offers the "convert to XLM" choice when a conversion route exists, so the
 * presence of that option is exactly the convertibility signal the UI needs.
 */
export function decisionPointsToConversions(plan: PlanResponse): AssetConvertibility[] {
  return plan.decisionPoints
    .filter((dp) => dp.type === "asset_disposition")
    .map((dp) => {
      const convertible = dp.options.some((o) => o.id === "convert_to_xlm");
      if (dp.subject.kind === "soroban_token") {
        const contract = String(dp.subject.contract ?? "");
        const symbol = typeof dp.subject.symbol === "string" ? dp.subject.symbol : null;
        const decimals = typeof dp.subject.decimals === "number" ? dp.subject.decimals : null;
        const rawBalance = String(dp.subject.balance ?? "0");
        // Convertible only with a quote the client can read: the convert answer must carry that
        // quote's floor, and offering the choice without one would produce a build the API
        // refuses for a decision the user had no way to complete.
        const quote = tokenQuoteOf(dp.subject.quote);
        return {
          asset: contract,
          code: symbol ?? `${contract.slice(0, 4)}…${contract.slice(-4)}`,
          balance: formatTokenBalance(rawBalance, decimals),
          convertible: convertible && quote !== undefined,
          token: {
            contract,
            symbol,
            decimals,
            rawBalance,
            arrivesFromExit: dp.subject.arrivesFromExit === true,
            ...(quote ? { quote } : {}),
          },
        };
      }
      const asset = String(dp.subject.asset ?? "");
      return {
        asset,
        code: asset.includes(":") ? asset.split(":")[0] : asset,
        balance: String(dp.subject.balance ?? "0"),
        convertible,
      };
    });
}

/** Per-claimable-balance decision consumed by the analyze UI. */
export interface ClaimableBalanceDecision {
  balanceId: string;
  asset: string;
  code: string;
  amount: string;
  /** Claimable now (native, or an authorized trustline exists) vs. needs remediation. */
  currentlyClaimable: boolean;
  /** This account's own claim predicate on the balance. */
  predicate: ClaimPredicate;
}

const UNCONDITIONAL: ClaimPredicate = { type: "unconditional" };

/**
 * Derives the analyze-page claimable-balance decision list from the API plan's
 * `claimable_balance` decision points.
 */
export function decisionPointsToClaimableBalances(plan: PlanResponse): ClaimableBalanceDecision[] {
  return plan.decisionPoints
    .filter((dp) => dp.type === "claimable_balance")
    .map((dp) => {
      const asset = String(dp.subject.asset ?? "");
      return {
        balanceId: String(dp.subject.balanceId ?? ""),
        asset,
        code: asset === "native" ? "XLM" : asset.split(":")[0],
        amount: String(dp.subject.amount ?? "0"),
        currentlyClaimable: Boolean(dp.subject.currentlyClaimable),
        predicate: (dp.subject.predicate as ClaimPredicate | undefined) ?? UNCONDITIONAL,
      };
    });
}

/**
 * Normalizes the API plan's serialized steps into full `PlannedStep`s for the store/sidebar,
 * adding the client-only execution fields (status, txXdr, txHash, error) the API omits.
 */
export function apiStepsToPlannedSteps(plan: PlanResponse): PlannedStep[] {
  return (plan.steps as Partial<PlannedStep>[]).map((s, i) => ({
    index: s.index ?? i,
    type: s.type as PlannedStep["type"],
    title: s.title ?? "",
    description: s.description ?? "",
    operationCount: s.operationCount ?? 0,
    estimatedFeeLumens: s.estimatedFeeLumens ?? "0",
    affectedAsset: s.affectedAsset,
    txXdr: null,
    status: "pending",
    txHash: null,
    error: null,
  }));
}
