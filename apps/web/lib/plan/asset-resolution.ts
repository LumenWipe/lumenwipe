import type { Network } from "@/config/networks";
import type { AssetConvertibility, ClaimableBalanceDecision } from "@/lib/api/plan-adapters";
import type { AssetDisposition, ClaimableBalanceSelection } from "@/types/plan";
import type { ClassicConversionFloor, TokenConversionFloor } from "@/store/demolish";
import { classicFloorFromQuote, isConversionImpactConfirmed } from "@/lib/api/close-decisions";
import { isUsableTransferDestination } from "@/lib/plan/transfer-destination";

/** What an asset's answer is read against: its transfer address, and the floors the convert
 *  answers carry with the ones the user confirmed for a flagged quote. */
export interface AssetAnswers {
  network: Network;
  dispositions: Record<string, AssetDisposition>;
  transferDestinations: Record<string, string>;
  tokenConversionFloors?: Readonly<Record<string, TokenConversionFloor>>;
  conversionImpactAcknowledgedFor?: Readonly<Record<string, string>>;
}

/**
 * The floor a convert answer for this asset carries: a token's quoted minimum, a classic asset's
 * quoted minimum less the drift allowance, or null for a classic asset only an exit pays in.
 * Undefined when the plan gives no floor, so a swap of it could not be held to any amount.
 *
 * The one rule for both what PlanView stores as the floors and what counts as answerable here,
 * so an answer shown as resolved always carries the floor the review and verify() require.
 */
export function convertFloorOf(
  c: AssetConvertibility
): TokenConversionFloor | ClassicConversionFloor | undefined {
  return c.token ? tokenFloorOf(c) : classicFloorOf(c);
}

/** A Soroban token's floor: its readable quote's minimum, with the provider it was quoted by. */
export function tokenFloorOf(c: AssetConvertibility): TokenConversionFloor | undefined {
  const quote = c.token?.quote;
  if (!quote) return undefined;
  const { minAmountOut, amountOut, provider, resolvedPath } = quote;
  return { minAmountOut, amountOut, provider, ...(resolvedPath ? { resolvedPath } : {}) };
}

/** A classic asset's floor: the quoted minimum less the drift allowance, or null when only an
 *  exit pays the asset in and there is nothing to quote until it lands. */
export function classicFloorOf(c: AssetConvertibility): ClassicConversionFloor | undefined {
  if (c.token || !c.convertible) return undefined;
  if (c.quote) return { minAmountOut: classicFloorFromQuote(c.quote.minAmountOut) };
  return c.arrivesFromExit ? { minAmountOut: null } : undefined;
}

/** An asset the plan offers a swap for, or the user answered "convert", with no floor to hold
 *  that swap to: converting it is not an answer the close can act on. */
export function convertUnfloored(
  c: AssetConvertibility,
  disposition: AssetDisposition | undefined
): boolean {
  const asksToConvert = disposition === "convert" || (disposition === undefined && c.convertible);
  return asksToConvert && convertFloorOf(c) === undefined;
}

/** Whether one balance-bearing asset has an answer the builder can act on. */
export function assetResolved(c: AssetConvertibility, answers: AssetAnswers): boolean {
  const { dispositions, transferDestinations } = answers;
  if (dispositions[c.asset] === "transfer") {
    // A transfer is resolved only once it names a usable address: the API can refuse a
    // missing destination, but a well-formed wrong one would be built and signed.
    return isUsableTransferDestination(transferDestinations[c.asset], answers.network);
  }
  // A Soroban token is resolved by an explicit "leave" as well; a trustline never is.
  if (c.token && dispositions[c.asset] === "leave") return true;
  // A swap with no floor, chosen or taken by default, is still open.
  if (convertUnfloored(c, dispositions[c.asset])) return false;
  // A flagged quote is never accepted by default: only an explicit convert the user confirmed
  // at the floor it carries resolves it.
  if (c.convertible && (c.token?.quote?.flags.length ?? 0) > 0) {
    return (
      dispositions[c.asset] === "convert" &&
      isConversionImpactConfirmed(
        c.asset,
        answers.tokenConversionFloors ?? {},
        answers.conversionImpactAcknowledgedFor ?? {}
      )
    );
  }
  return c.convertible || dispositions[c.asset] === "issuer";
}

/**
 * Whether the asset cards were withheld: the account holds balances, but the plan's asset list
 * came back empty.
 *
 * The interesting case is the one a render test would not think to construct: `[].every(...)` is
 * `true`, so an EMPTY list of assets reads as "all resolved". That is right when the account holds
 * none, and badly wrong when the list is empty because the cards were withheld - the user was
 * never shown a choice, and letting it pass sends them to a build the API refuses for decisions
 * they had no way to make. `balanceBearingCount` comes from the account read, so the two cases
 * can be told apart by something other than the list that is in question.
 */
export function assetCardsWithheld(
  conversions: readonly AssetConvertibility[],
  balanceBearingCount: number
): boolean {
  return balanceBearingCount > 0 && conversions.length === 0;
}

/** Whether every balance-bearing asset has an answer the builder can act on. */
export function assetsResolved(
  input: AssetAnswers & {
    conversions: AssetConvertibility[];
    /** Trustlines with a non-zero balance, from the account state. */
    balanceBearingCount: number;
  }
): boolean {
  if (assetCardsWithheld(input.conversions, input.balanceBearingCount)) return false;
  return input.conversions.every((c) => assetResolved(c, input));
}

/**
 * Whether a claimable balance has an answer the plan offers. An unanswered balance the plan lets
 * the account claim is resolved, since claiming is its default; any other balance needs an
 * explicit answer, and one whose options could not be read offers none and stays unresolved.
 */
export function claimResolved(
  decision: Pick<ClaimableBalanceDecision, "offered">,
  selection: ClaimableBalanceSelection | undefined
): boolean {
  if (selection === undefined) return decision.offered.includes("claim");
  return decision.offered.includes(selection);
}
