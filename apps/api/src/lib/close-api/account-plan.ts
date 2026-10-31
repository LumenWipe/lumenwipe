import type { AccountState } from "@lumenwipe/types";
import type { Network } from "@/config/networks";
import { stroopsToFixedXlm, xlmToStroops } from "@/lib/utils/amounts";
import { readAccountState } from "@/lib/close-api/read-account";
import { fetchConversionPath } from "@/lib/stellar/path-finding";
import { buildPlan, heldSorobanTokens } from "@/lib/stellar/tx-builder";
import {
  assessSponsorshipAffordability,
  type SponsorshipAffordability,
} from "@/lib/stellar/sponsorship-affordability";
import { requiresMediatorForAddress } from "@/lib/exchange-registry";
import { assessIssuance } from "@/lib/close-api/issuance-preflight";
import { assessIssuanceBlockers } from "@/lib/close-api/issuance-blocker";
import { assessMergePreflight } from "@/lib/close-api/merge-preflight";
import { validateTransferDestinations } from "@/lib/close-api/transfer-destinations";
import { quoteTokenToXlm, xlmContractId } from "@/lib/soroswap/conversion-quotes";
import {
  quoteTokenToXlmViaXBull,
  fetchXBullSwapArgs,
  defaultXBullConversionDeps,
} from "@/lib/xbull/conversion-quotes";
import {
  quoteAllProviders,
  resolveTokenQuoteSummary,
  PROVIDER_QUOTE_TIMEOUT_MS,
} from "@/lib/close-api/multi-source-conversion";
import { withTimeout } from "@/lib/utils/with-timeout";
import { resolveXBullPath } from "@/lib/close-api/token-conversion-round";
import { getRpcServer } from "@/lib/stellar/rpc";
import { readTrustlinesOnly } from "@/lib/stellar/account-state";
import {
  assetDecisionId,
  claimedAmountsPerAsset,
  deriveClaimableBalanceDecisionPoints,
  decisionIdFor,
  deriveDecisionPoints,
  type TokenQuoteSummary,
  deriveTokenDecisionPoints,
  tokenAssetsById,
  tokenContractsFromAnswers,
  deriveDestinationDecisionPoints,
  destinationDecisionId,
  isDestinationAcknowledged,
  resolveClaimSelections,
  deriveBulkClaimDecisionPoints,
  resolveDispositions,
  collectTransferDestinations,
  deriveDefiPositionsDecisionPoints,
  defiPositionsDecisionId,
  isDefiPositionsAcknowledged,
  deriveIssuerSupplyDecisionPoints,
  issuerSupplyDecisionId,
  isIssuerSupplyAcknowledged,
  deriveLeavePositionDecisionPoints,
  positionsLeftBehind,
  PRICE_SOURCE_UNAVAILABLE,
  ROUTE_LOOKUP_UNAVAILABLE_CODE,
  type ClassicQuote,
} from "@/lib/close-api/decisions";
import { ARRIVING_ASSET_PROBE_AMOUNT, assetsArrivingFromExits } from "@/lib/close-api/exit-payouts";
import { DEFI_POSITIONS_UNAVAILABLE_CODE } from "@/lib/defi-positions/positions-gate";
import { preflightExitTargets } from "@/lib/defi-exits/exit-round";
import {
  planExitSteps,
  type ExitPreflight,
  type ExitTargetBlock,
} from "@/lib/defi-exits/plan-exits";
import { assemblePlanResponse, computePlanHash } from "@/lib/close-api/plan-response";
import { BASE_FEE_STROOPS } from "@/config/constants";
import type { DecisionAnswer, DecisionPoint, PlanResponse, Trustline } from "@lumenwipe/types";

/** Quotes per plan are bounded like discovery candidates; a token past this is offered no swap. */
const MAX_TOKEN_QUOTES = 20;

export const EXIT_PREFLIGHT_TIMEOUT_MS = 10_000;

export interface AccountPlanDeps {
  preflightExits?: typeof preflightExitTargets;
}

/**
 * Which exit targets cannot be built and may be left behind. Only those change the plan: the
 * preflight grades each target alone, while the round runs them in order (an earlier exit can pay
 * the asset a later repay needs), so any other blocker is left for the round to decide, as before.
 * A preflight that fails or runs long reports nothing; the round re-runs every check itself and
 * refuses to build what it cannot, so a missing preflight never lets a merge pass a position.
 */
async function exitPreflightFor(
  accountState: AccountState,
  network: Network,
  preflight: typeof preflightExitTargets
): Promise<ReadonlyMap<string, ExitTargetBlock>> {
  if (accountState.defiPositions.positions.length === 0) return new Map();
  try {
    const blocked = await withTimeout(
      preflight(accountState, network, { rpc: getRpcServer(network) }),
      EXIT_PREFLIGHT_TIMEOUT_MS,
      `exit preflight exceeded ${EXIT_PREFLIGHT_TIMEOUT_MS} ms`
    );
    return new Map([...blocked].filter(([, block]) => block.leaveEligible));
  } catch {
    return new Map();
  }
}

/**
 * Reads a transfer destination's trustlines, treating "does not exist" as an answer rather than
 * an error.
 *
 * Only the trustlines: these addresses are named freely by the caller, one per asset, so the
 * full `readAccountState` - which also paginates offers and claimable balances and can enumerate
 * thousands of sponsorship operations - would turn one inbound request into an unbounded
 * upstream fan-out, and would fail a destination merely for holding more than 1000 offers.
 */
const readDestinationTrustlines = async (
  address: string,
  net: Network
): Promise<{ trustlines: Trustline[] } | null> => readTrustlinesOnly(address, net);

export function pricedAmountsPerAsset(
  accountState: AccountState,
  claimedPerAsset: Map<string, bigint>
): { asset: string; amount: string; probe?: true }[] {
  const pricedByAsset = new Map<string, bigint>();
  const probed = new Set<string>();
  for (const tl of accountState.trustlines) {
    const total = BigInt(xlmToStroops(tl.balance)) + (claimedPerAsset.get(tl.asset) ?? 0n);
    if (total > 0n) pricedByAsset.set(tl.asset, total);
  }
  for (const [asset, amount] of claimedPerAsset) {
    if (!pricedByAsset.has(asset)) pricedByAsset.set(asset, amount);
  }
  // An asset an exit will pay in holds nothing yet, so it is priced at a nominal unit: this
  // is the "is there a market at all" gate that decides which options the card offers, and
  // the amount that actually arrives is re-quoted at build time anyway.
  for (const asset of assetsArrivingFromExits(accountState)) {
    if (!pricedByAsset.has(asset)) {
      pricedByAsset.set(asset, BigInt(xlmToStroops(ARRIVING_ASSET_PROBE_AMOUNT)));
      probed.add(asset);
    }
  }
  return [...pricedByAsset.entries()].map(([asset, amount]) => ({
    asset,
    amount: stroopsToFixedXlm(amount),
    ...(probed.has(asset) ? { probe: true as const } : {}),
  }));
}

/**
 * Builds a deterministic close plan for one account: reads live state, prices every held or
 * arriving asset, derives decision points, and reports blockers. This is the single source of
 * plan-building logic shared by `POST close/plan` (one address, decisions applied) and
 * `POST close/batch-plan` (many addresses, always `decisions: []`) - extracted so a batch call
 * reuses this exactly rather than re-deriving it (issue #288).
 *
 * Throws `AccountNotFoundError`, `TruncatedCollectionError`, or `UnusableProviderResponseError`
 * on a read that cannot be planned safely; callers translate these into their own error
 * contract (an HTTP failure for the single-account endpoint, a per-address blocker for the batch
 * one).
 */
export async function buildAccountPlan(
  source: string,
  destination: string | null,
  decisions: DecisionAnswer[],
  network: Network,
  deps: AccountPlanDeps = {}
): Promise<PlanResponse> {
  const accountState = await readAccountState(
    source,
    network,
    tokenContractsFromAnswers(decisions)
  );
  const mediatorRequired = destination ? requiresMediatorForAddress(destination) : false;
  const issuancePromise = assessIssuance(source, network);
  const exitPreflightPromise = exitPreflightFor(
    accountState,
    network,
    deps.preflightExits ?? preflightExitTargets
  );

  const convertibility: Record<string, boolean> = {};
  const nonClaimableSponsoredEntries = accountState.sponsoredEntries.filter(
    (e) => e.kind !== "claimable_balance"
  );
  // Priced together, at the amount that will actually need a route: what the account holds
  // now PLUS what the claims it chose will add, summed per asset by the same
  // will-it-be-claimed rule buildPlan uses (claimedAmountsPerAsset). Pricing per balance
  // asked path finding about a smaller amount than the step will move, and two balances of
  // one asset raced their answers into convertibility[asset] - last write won, so the
  // offered options could flap between re-plans.
  const claimableBalanceSelections = resolveClaimSelections(decisions, accountState);
  const claimedPerAsset = claimedAmountsPerAsset(accountState, claimableBalanceSelections);
  const pricedAssets = pricedAmountsPerAsset(accountState, claimedPerAsset);
  const priceSourceUnavailable = new Set<string>();
  const dustAssets = new Set<string>();
  // The quote shown for a held or claimed balance becomes the floor the convert answer carries.
  // An asset priced at the exit probe amount gets none: its real amount is unknown until it lands.
  const classicQuotes: Record<string, ClassicQuote> = {};
  const convertibilityPromise = Promise.all(
    pricedAssets.map(async ({ asset, amount, probe }) => {
      const result = await fetchConversionPath(asset, amount, network);
      if (result.kind === "unavailable") priceSourceUnavailable.add(asset);
      else {
        convertibility[asset] = result.kind === "route";
        if (result.kind === "route" && !probe) {
          classicQuotes[asset] = {
            estimatedReceive: xlmToStroops(result.path.estimatedReceive),
            minAmountOut: xlmToStroops(result.path.destMin),
          };
        }
        if (result.kind === "none" && result.reason === "dust_below_minimum") dustAssets.add(asset);
      }
    })
  );
  const sponsorshipAffordabilityPromise: Promise<SponsorshipAffordability> =
    accountState.sponsorshipEnumerationIncomplete
      ? Promise.resolve({ revocable: [], unaffordableOwners: new Map() })
      : assessSponsorshipAffordability(source, nonClaimableSponsoredEntries, network);
  // Raced across both providers (Soroswap and xBull), one quote per held token with
  // readable metadata; anything else is offered transfer or leave. Neither provider is a
  // hard dependency for the other - quoteAllProviders never throws, so a provider that is
  // disabled, errors, or times out simply contributes no candidate, and
  // resolveTokenQuoteSummary picks whichever candidate delivers more XLM (falling back off
  // an xBull win whose route cannot be confirmed live).
  const tokenQuotes: Record<string, TokenQuoteSummary | null> = {};
  const tokenQuotePromise = Promise.all(
    (accountState.sorobanTokens?.tokens ?? [])
      .filter((t) => t.symbol !== null && t.decimals !== null && /^[1-9]\d*$/.test(t.balance))
      .slice(0, MAX_TOKEN_QUOTES)
      .map(async (t) => {
        const results = await quoteAllProviders(t.contract, BigInt(t.balance), network, {
          soroswap: quoteTokenToXlm,
          xbull: quoteTokenToXlmViaXBull,
        });
        // xBull's own route is confirmed live, once more, before it is ever offered: see
        // `resolveTokenQuoteSummary`'s docstring for why an unresolved route falls back
        // rather than being shown at all. Bounded the same way every other provider call
        // already is - xBull's own build endpoint is independently unreliable, and without
        // a timeout a hang here would stall the whole plan response even though the other
        // provider already answered.
        tokenQuotes[t.contract] = await resolveTokenQuoteSummary(
          results,
          (winner) =>
            withTimeout(
              fetchXBullSwapArgs(
                (winner.quote.raw as { route: string }).route,
                source,
                BigInt(winner.quote.amountIn),
                BigInt(winner.quote.minAmountOut),
                defaultXBullConversionDeps()
              ).then((contractArgsXDR) =>
                contractArgsXDR
                  ? resolveXBullPath(getRpcServer(network), contractArgsXDR)
                  : undefined
              ),
              PROVIDER_QUOTE_TIMEOUT_MS,
              `xBull route resolution exceeded ${PROVIDER_QUOTE_TIMEOUT_MS} ms`
            ),
          t.contract,
          xlmContractId(network)
        );
      })
  );
  const [, sponsorshipAffordability, , issuance, blockedExits] = await Promise.all([
    convertibilityPromise,
    sponsorshipAffordabilityPromise,
    tokenQuotePromise,
    issuancePromise,
    exitPreflightPromise,
  ]);
  const leftBehind = positionsLeftBehind(decisions, source);
  const exitPreflight: ExitPreflight = { blocked: blockedExits, leftBehind };

  // Every asset the close will touch answers here - held or arriving. Without the arriving
  // ones their disposition never resolves, and the plan would label a balance the caller
  // chose to return to its issuer as a conversion - the same untruth on the consent surface
  // that #139 removed. The Set dedupes an asset that is both held and being topped up.
  const planAssetsById = [
    ...[
      ...new Set([...accountState.trustlines.map((tl) => tl.asset), ...claimedPerAsset.keys()]),
    ].map((asset) => ({ id: assetDecisionId(asset), asset })),
    // Soroban token balances decide alongside: convert, transfer as the token, or leave on
    // record. No route pricing yet - conversion is offered once a quote source exists.
    ...tokenAssetsById(accountState),
  ];
  // A transfer answer is well-formed whether or not it names a usable account, so both halves
  // are taken here. The destinations that resolved describe the plan's asset steps and feed
  // the live-ledger check below; the ones that did not go back on the pending list.
  const { destinations: planDestinations, missing: missingDestinations } =
    collectTransferDestinations(decisions, planAssetsById);
  const planDispositions = resolveDispositions(decisions, planAssetsById);

  // Whether the unconfirmed-positions gate would produce its hard-blocking code on THIS
  // read, before any acknowledgement is applied - decides whether the decision point below
  // even needs to exist. accountState.defiPositionsWarnings is already this exact,
  // unacknowledged computation (account-state.ts), so it is reused rather than re-derived.
  const needsDefiPositionsAck = accountState.defiPositionsWarnings.some(
    (w) => w.code === DEFI_POSITIONS_UNAVAILABLE_CODE
  );
  const defiPositionsAcknowledged = isDefiPositionsAcknowledged(decisions, source);

  const issuerSupplyAcknowledged = isIssuerSupplyAcknowledged(decisions, source);

  const buildResult = buildPlan(
    accountState,
    mediatorRequired,
    false,
    claimableBalanceSelections,
    sponsorshipAffordability,
    planDispositions,
    planDestinations,
    accountState.defiPositions,
    defiPositionsAcknowledged,
    exitPreflight
  );
  const leavePoints = deriveLeavePositionDecisionPoints(
    source,
    planExitSteps(accountState.defiPositions.positions, 0, exitPreflight).leavable
  );
  const leaveContractById = new Map(leavePoints.map((dp) => [dp.id, String(dp.subject.contract)]));
  const decisionPoints = [
    ...deriveDestinationDecisionPoints(destination),
    ...deriveDefiPositionsDecisionPoints(source, needsDefiPositionsAck),
    ...deriveDecisionPoints(
      accountState,
      convertibility,
      claimableBalanceSelections,
      priceSourceUnavailable,
      dustAssets,
      classicQuotes
    ),
    ...deriveIssuerSupplyDecisionPoints(source, issuance),
    ...leavePoints,
    ...deriveTokenDecisionPoints(accountState, tokenQuotes),
    ...deriveClaimableBalanceDecisionPoints(accountState),
    ...deriveBulkClaimDecisionPoints(accountState),
  ];
  const answeredIds = new Set(decisions.map((d) => d.id));
  // The destination and DeFi-positions acknowledgements are judged on their choice, not
  // merely on having been answered. For every other decision the choice is re-validated
  // downstream against a known value set, so presence is a fair proxy; here the choice IS
  // the content, and reporting "ready" for an answer that /transactions will refuse leaves
  // a caller with a 422 and no pending decision to point at.
  const pending: DecisionPoint[] = decisionPoints.filter((dp) => {
    if (destination !== null && dp.id === destinationDecisionId(destination)) {
      return !isDestinationAcknowledged(decisions, destination);
    }
    if (dp.id === defiPositionsDecisionId(source)) return !defiPositionsAcknowledged;
    if (dp.id === issuerSupplyDecisionId(source)) return !issuerSupplyAcknowledged;
    const leaveContract = leaveContractById.get(dp.id);
    if (leaveContract !== undefined) return !leftBehind.has(leaveContract);
    if (!dp.required) return false;
    if (dp.type === "claimable_balance") {
      return !answeredIds.has(dp.id) && !claimableBalanceSelections[String(dp.subject.balanceId)];
    }
    return !answeredIds.has(dp.id);
  });

  // Same reasoning as the acknowledgement above, one step further out: a transfer answer is
  // well-formed whether or not it names a usable account, so it counts as answered and the
  // plan would report "ready" for a close /transactions then refuses. `missingDestinations`
  // (collected above, before the plan was built) is surfaced here instead - while the caller
  // can still change the answer, and while nothing has been built or signed.
  //
  // An answer with no usable destination is unanswered in the only sense that matters, so it
  // goes back on the pending list rather than being swallowed. The previous version relied on
  // it already being pending, which it never was: `pending` is keyed on the answer's id, and
  // the id is present.
  for (const asset of missingDestinations) {
    const id = decisionIdFor(asset);
    const point = decisionPoints.find((dp) => dp.id === id);
    if (point && !pending.includes(point)) pending.push(point);
  }

  const transferProblems = await validateTransferDestinations(
    planDestinations,
    accountState.trustlines,
    source,
    network,
    readDestinationTrustlines
  );
  if (transferProblems.length > 0) {
    buildResult.blockers = [
      ...buildResult.blockers,
      // No `code`: on PlanBlocker that field marks an acknowledged, non-trapping warning,
      // and these must trap. A close that cannot pay one of its assets is not a warning.
      ...transferProblems.map((p) => ({ message: p.message })),
    ];
  }

  buildResult.blockers = [
    ...buildResult.blockers,
    ...assessIssuanceBlockers(issuance, issuerSupplyAcknowledged),
  ];

  if (priceSourceUnavailable.size > 0) {
    buildResult.blockers = [
      ...buildResult.blockers,
      { code: ROUTE_LOOKUP_UNAVAILABLE_CODE, message: PRICE_SOURCE_UNAVAILABLE },
    ];
  }

  const mergeProblems = await assessMergePreflight(accountState, destination, network);
  if (mergeProblems.length > 0) {
    buildResult.blockers = [
      ...buildResult.blockers,
      ...mergeProblems.map((p) => ({ message: p.message })),
    ];
  }

  const planHash = computePlanHash({
    source,
    destination,
    decisions,
    sourceSequence: accountState.sequence,
  });

  const totalOps = buildResult.steps.reduce((n, s) => n + s.operationCount, 0);
  const estimate = {
    feeStroops: String(totalOps * BASE_FEE_STROOPS),
    freedReserveXlm: ((2 + accountState.numSubEntries) * 0.5).toFixed(7),
  };

  // Every decision point goes back, answered or not - the caller renders its cards from
  // this list and knows its own answers. Only the status cares about what remains.
  return assemblePlanResponse({
    buildResult,
    decisionPoints,
    pendingDecisionPoints: pending,
    planHash,
    estimate,
    execution: {
      viaMediator: mediatorRequired,
      decided:
        destination !== null &&
        heldSorobanTokens(accountState).every((t) => planDispositions[t.contract] !== undefined),
    },
  });
}
