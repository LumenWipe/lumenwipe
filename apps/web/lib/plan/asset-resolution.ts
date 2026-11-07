import type { AssetConvertibility, ClaimableBalanceDecision } from "@/lib/api/plan-adapters";
import type { AssetDisposition, ClaimableBalanceSelection } from "@/types/plan";
import type { TokenConversionFloor } from "@/store/demolish";
import { isConversionImpactConfirmed } from "@/lib/api/close-decisions";
import { isValidGAddress } from "@/lib/utils/validation";

/** What an asset's answer is read against: its transfer address, and the floors the convert
 *  answers carry with the ones the user confirmed for a flagged quote. */
export interface AssetAnswers {
  dispositions: Record<string, AssetDisposition>;
  transferDestinations: Record<string, string>;
  tokenConversionFloors?: Readonly<Record<string, TokenConversionFloor>>;
  conversionImpactAcknowledgedFor?: Readonly<Record<string, string>>;
}

/** Whether one balance-bearing asset has an answer the builder can act on. */
export function assetResolved(c: AssetConvertibility, answers: AssetAnswers): boolean {
  const { dispositions, transferDestinations } = answers;
  if (dispositions[c.asset] === "transfer") {
    // A transfer is resolved only once it names a usable address: the API can refuse a
    // missing destination, but a well-formed wrong one would be built and signed.
    const destination = transferDestinations[c.asset];
    return !!destination && isValidGAddress(destination);
  }
  // A Soroban token is resolved by an explicit "leave" as well; a trustline never is.
  if (c.token && dispositions[c.asset] === "leave") return true;
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
