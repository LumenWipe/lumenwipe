import type { PlanResponse } from "@lumenwipe/sdk";
import type { ClaimableBalanceSelection, PlannedStep, StepType } from "@/types/plan";
import type { ClaimPredicate } from "@/types/account";
import type { TokenQuoteFlag, TokenUnquotedReason } from "@lumenwipe/types";
import type { ClassicConversionQuote, ExecutionTxBreakdown } from "@/types/close-api";

/**
 * Per-asset convertibility consumed by the analyze UI. Relocated here from the old
 * client-side builder (fast-path) now that the plan comes from the API.
 */
export interface AssetConvertibility {
  /** The classic asset (`CODE:ISSUER`) or, for a Soroban token, its contract id. */
  asset: string;
  code: string;
  /** The issuer of a classic asset: the part of `asset` after the code. */
  issuer?: string;
  /** Human-readable balance: decimal for a classic asset or a token with known decimals. */
  balance: string;
  convertible: boolean;
  /** A market exists but the balance would receive nothing once slippage is applied. */
  dust?: boolean;
  /** True when nothing holds this asset yet and the balance is what a position's exit will pay
   *  in. The disposition is still required - it is answered before the exit runs, not after. */
  arrivesFromExit?: boolean;
  /** The issuer can reclaim this balance at any time. Disclosure only; it changes no option. */
  clawbackEnabled?: boolean;
  /** For a convertible classic asset priced at the balance it will move: the XLM the plan
   *  quoted and the least the conversion may deliver, in stroops. */
  quote?: ClassicConversionQuote;
  /** Present for a Soroban token: its contract and the raw balance verify() holds a transfer to.
   *  `arrivesFromExit`: the balance is what a position's exit will pay out, not what is held now. */
  token?: {
    contract: string;
    symbol: string | null;
    decimals: number | null;
    rawBalance: string;
    arrivesFromExit: boolean;
    /** The plan's conversion quote when a route exists: XLM out and the floor, in stroops. */
    quote?: TokenQuote;
    /** Why the plan offers no conversion, when it says so. */
    reason?: TokenUnquotedReason;
  };
}

/** A Soroban contract id, the same shape `verify.ts`'s own `CONTRACT_ID` checks. */
const CONTRACT_ID = /^C[A-Z2-7]{55}$/;

export interface TokenQuote {
  amountOut: string;
  minAmountOut: string;
  platform: string;
  route: string[];
  /** Which provider's quote this is: which one the plan-time race picked. */
  provider: "soroswap" | "xbull";
  /** Only for an `xbull` win: the live route (token addresses, in order, ending at XLM) the API
   *  resolved once more at plan time - the same route `verify.ts`'s trust anchor needs to hold a
   *  later `strict_send` call to before it is ever signed. Absent for a Soroswap win, or when
   *  xBull's route could not be confirmed live (the plan never offers that as convertible). */
  resolvedPath?: string[];
  /** The price impact in basis points; null when the plan could not measure it. */
  priceImpactBps: number | null;
  /** Why converting is not recommended and needs the user's confirmation; empty when it is. */
  flags: TokenQuoteFlag[];
  /** The other provider's quote, when both answered. */
  runnerUp?: { provider: "soroswap" | "xbull"; amountOut: string; minAmountOut: string };
}

const TOKEN_QUOTE_FLAGS: readonly TokenQuoteFlag[] = [
  "high_impact",
  "impact_unknown",
  "provider_disagreement",
];
const TOKEN_UNQUOTED_REASONS: readonly TokenUnquotedReason[] = [
  "quote_limit",
  "provider_unavailable",
  "no_route",
  "metadata_unreadable",
];

/** The flags a quote carries. Anything unreadable counts as "impact unknown": a flag the client
 *  cannot read must never turn into a quote shown as unremarkable. */
function flagsOf(raw: unknown): TokenQuoteFlag[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return ["impact_unknown"];
  const known = raw.filter((f): f is TokenQuoteFlag => TOKEN_QUOTE_FLAGS.includes(f));
  return known.length === raw.length ? known : [...new Set([...known, "impact_unknown" as const])];
}

function runnerUpOf(raw: unknown): TokenQuote["runnerUp"] {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (r.provider !== "soroswap" && r.provider !== "xbull") return undefined;
  if (typeof r.amountOut !== "string" || !/^\d+$/.test(r.amountOut)) return undefined;
  if (typeof r.minAmountOut !== "string" || !/^\d+$/.test(r.minAmountOut)) return undefined;
  return { provider: r.provider, amountOut: r.amountOut, minAmountOut: r.minAmountOut };
}

function classicQuoteOf(raw: unknown): ClassicConversionQuote | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const q = raw as Record<string, unknown>;
  if (typeof q.estimatedReceive !== "string" || typeof q.minAmountOut !== "string")
    return undefined;
  if (!/^[1-9]\d*$/.test(q.estimatedReceive) || !/^[1-9]\d*$/.test(q.minAmountOut)) {
    return undefined;
  }
  return { estimatedReceive: q.estimatedReceive, minAmountOut: q.minAmountOut };
}

function tokenQuoteOf(raw: unknown): TokenQuote | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const q = raw as Record<string, unknown>;
  if (typeof q.amountOut !== "string" || typeof q.minAmountOut !== "string") return undefined;
  if (!/^\d+$/.test(q.amountOut) || !/^[1-9]\d*$/.test(q.minAmountOut)) return undefined;
  if (q.provider !== "soroswap" && q.provider !== "xbull") return undefined;
  const resolvedPath = Array.isArray(q.resolvedPath)
    ? q.resolvedPath.filter((r): r is string => typeof r === "string" && CONTRACT_ID.test(r))
    : undefined;
  // A resolvedPath present but not entirely well-formed is worth nothing to the trust anchor -
  // it would either fail to match anything (safe) or, worse, look plausible while silently
  // missing hops. Dropping it here rather than passing a partial list keeps the token
  // unconvertible-by-xBull rather than convertible-on-a-corrupted-route.
  const wellFormedPath =
    Array.isArray(q.resolvedPath) &&
    resolvedPath !== undefined &&
    resolvedPath.length === q.resolvedPath.length &&
    resolvedPath.length >= 2
      ? resolvedPath
      : undefined;
  return {
    amountOut: q.amountOut,
    minAmountOut: q.minAmountOut,
    platform: typeof q.platform === "string" ? q.platform : "",
    route: Array.isArray(q.route) ? q.route.filter((r): r is string => typeof r === "string") : [],
    provider: q.provider,
    ...(wellFormedPath ? { resolvedPath: wellFormedPath } : {}),
    priceImpactBps:
      typeof q.priceImpactBps === "number" &&
      Number.isInteger(q.priceImpactBps) &&
      q.priceImpactBps >= 0
        ? q.priceImpactBps
        : null,
    flags: flagsOf(q.flags),
    ...(runnerUpOf(q.runnerUp) ? { runnerUp: runnerUpOf(q.runnerUp) } : {}),
  };
}

/** The plan's estimated fee in stroops, or null when the response carries none that is usable. */
export function planFeeStroopsOf(plan: PlanResponse): string | null {
  const fee: unknown = plan.estimate?.feeStroops;
  return typeof fee === "string" && /^\d+$/.test(fee) ? fee : null;
}

/** How many transactions the plan expects the close to take, for /review. Display only. Null
 *  unless it is a positive whole count: a count is never shown from a value that is not one. */
export function planTransactionCountOf(plan: PlanResponse): number | null {
  const count: unknown = (plan as { execution?: { estimatedTransactionCount?: unknown } }).execution
    ?.estimatedTransactionCount;
  return typeof count === "number" && Number.isSafeInteger(count) && count > 0 ? count : null;
}

const STEP_TYPES: ReadonlySet<string> = new Set<StepType>([
  "NORMALIZE_SIGNERS",
  "REVOKE_SPONSORSHIP",
  "REMOVE_DATA_ENTRIES",
  "CANCEL_OFFERS",
  "ADD_TRUSTLINE_FOR_CLAIM",
  "CLAIM_BALANCES",
  "EXIT_POSITIONS",
  "HANDLE_ASSETS",
  "REMOVE_TRUSTLINES",
  "CLOSE_ACCOUNT",
  "MERGE",
]);

function isBreakdown(value: unknown): value is ExecutionTxBreakdown {
  if (typeof value !== "object" || value === null) return false;
  const { order, covers } = value as Record<string, unknown>;
  return (
    typeof order === "number" &&
    Number.isSafeInteger(order) &&
    order >= 0 &&
    Array.isArray(covers) &&
    covers.every((c) => typeof c === "string" && STEP_TYPES.has(c))
  );
}

/** The plan's transactions in build order, for the multisig statement. Display only. Null unless
 *  every entry is well formed and there is at least one. */
export function planTransactionsOf(plan: PlanResponse): ExecutionTxBreakdown[] | null {
  const txs: unknown = (plan as { execution?: { transactions?: unknown } }).execution?.transactions;
  if (!Array.isArray(txs) || txs.length === 0 || !txs.every(isBreakdown)) return null;
  return txs
    .map((t) => ({ order: t.order, covers: [...t.covers] }))
    .sort((a, b) => a.order - b.order);
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
            ...(TOKEN_UNQUOTED_REASONS.includes(dp.subject.reason as TokenUnquotedReason)
              ? { reason: dp.subject.reason as TokenUnquotedReason }
              : {}),
          },
        };
      }
      const asset = String(dp.subject.asset ?? "");
      const [code, issuer] = asset.split(":");
      return {
        asset,
        code,
        ...(issuer ? { issuer } : {}),
        balance: String(dp.subject.balance ?? "0"),
        convertible,
        ...(dp.subject.reason === "dust_below_minimum" ? { dust: true } : {}),
        arrivesFromExit: dp.subject.arrivesFromExit === true,
        ...(dp.subject.clawbackEnabled === true ? { clawbackEnabled: true } : {}),
        ...(convertible && classicQuoteOf(dp.subject.quote)
          ? { quote: classicQuoteOf(dp.subject.quote) }
          : {}),
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
  /** The answers the plan offers for this balance, in display order. Only these may be chosen:
   *  the API refuses any other at build time, after review. Empty when the plan's options could
   *  not be read, which leaves the balance with no choice and unresolved. */
  offered: ClaimableBalanceSelection[];
  /** Why the balance cannot be claimed in this close, from the plan, when leaving it is the only
   *  answer offered. */
  unclaimableNote: string | null;
}

const UNCONDITIONAL: ClaimPredicate = { type: "unconditional" };

const CLAIM_SELECTIONS: readonly ClaimableBalanceSelection[] = [
  "claim",
  "add_trustline_then_claim",
  "forfeit",
];

type ClaimOptions = PlanResponse["decisionPoints"][number]["options"];

/** The readable options of a decision point: anything that is not a list of options offers
 *  nothing, and an entry with no id is skipped. */
function readableOptions(options: unknown): ClaimOptions {
  if (!Array.isArray(options)) return [];
  return options.filter(
    (o): o is ClaimOptions[number] => typeof (o as { id?: unknown } | null)?.id === "string"
  );
}

/** The recognized answers among a decision point's options, in a fixed order. */
function offeredClaimSelections(options: ClaimOptions): ClaimableBalanceSelection[] {
  const ids = new Set<string>(options.map((o) => o.id));
  return CLAIM_SELECTIONS.filter((s) => ids.has(s));
}

/**
 * Derives the analyze-page claimable-balance decision list from the API plan's
 * `claimable_balance` decision points.
 */
export function decisionPointsToClaimableBalances(plan: PlanResponse): ClaimableBalanceDecision[] {
  return plan.decisionPoints
    .filter((dp) => dp.type === "claimable_balance")
    .map((dp) => {
      const asset = String(dp.subject.asset ?? "");
      const options = readableOptions(dp.options);
      const offered = offeredClaimSelections(options);
      const forfeitNote = options.find((o) => o.id === "forfeit")?.note;
      return {
        balanceId: String(dp.subject.balanceId ?? ""),
        asset,
        code: asset === "native" ? "XLM" : asset.split(":")[0],
        amount: String(dp.subject.amount ?? "0"),
        currentlyClaimable: Boolean(dp.subject.currentlyClaimable),
        predicate: (dp.subject.predicate as ClaimPredicate | undefined) ?? UNCONDITIONAL,
        offered,
        unclaimableNote:
          offered.length === 1 && offered[0] === "forfeit" && typeof forfeitNote === "string"
            ? forfeitNote
            : null,
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
    // Dropping this left the receipt's "DeFi positions exited" group unable to render at all:
    // it matches confirmed exit steps to detected positions by contract, and the contract never
    // survived the boundary. The API has always sent it (`defi-exits/plan-exits.ts`).
    affectedContract: s.affectedContract,
    txXdr: null,
    status: "pending",
    txHash: null,
    error: null,
  }));
}

/** A DeFi position whose exit cannot be built, which the user may choose to leave behind. */
export interface LeavablePosition {
  /** The API's decision id for this choice; the answer is sent back under it. */
  decisionId: string;
  /** The protocol's display name. */
  protocol: string;
  contract: string;
  /** USD value as a decimal string, or null when the plan could not price it. */
  usdValue: string | null;
  /** Why it cannot be exited, in the plan's words. */
  reason: string;
  /** What the user confirms by leaving it, in the plan's words. */
  note: string;
}

export function decisionPointsToLeavablePositions(plan: PlanResponse): LeavablePosition[] {
  return plan.decisionPoints.flatMap((dp) => {
    if (dp.type !== "confirmation" || dp.subject.kind !== "defi_position_leave") return [];
    const contract = String(dp.subject.contract ?? "");
    const note = dp.options.find((o) => o.id === "leave_position_behind")?.note;
    if (!CONTRACT_ID.test(contract) || typeof note !== "string") return [];
    return [
      {
        decisionId: dp.id,
        protocol: String(dp.subject.label ?? dp.subject.protocol ?? ""),
        contract,
        usdValue: typeof dp.subject.usdValue === "string" ? dp.subject.usdValue : null,
        reason: String(dp.subject.reason ?? ""),
        note,
      },
    ];
  });
}
