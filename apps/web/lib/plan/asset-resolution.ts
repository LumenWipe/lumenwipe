import type { AssetConvertibility } from "@/lib/api/plan-adapters";
import type { AssetDisposition } from "@/types/plan";
import type { TokenConversionFloor } from "@/store/demolish";
import { isConversionImpactConfirmed } from "@/lib/api/close-decisions";
import { isValidGAddress } from "@/lib/utils/validation";

/**
 * Whether every balance-bearing asset has an answer the builder can act on.
 *
 * Extracted from the plan view because the interesting case is the one a render test would not
 * think to construct: `[].every(...)` is `true`, so an EMPTY list of assets reads as "all
 * resolved". That is right when the account holds none, and badly wrong when the list is empty
 * because the cards were withheld - the user was never shown a choice, and letting it pass
 * sends them to a build the API refuses for decisions they had no way to make.
 *
 * `balanceBearingCount` comes from the account read, so the two cases can be told apart by
 * something other than the list that is in question.
 */
export function assetsResolved(input: {
  conversions: AssetConvertibility[];
  /** Trustlines with a non-zero balance, from the account state. */
  balanceBearingCount: number;
  dispositions: Record<string, AssetDisposition>;
  transferDestinations: Record<string, string>;
  /** The floors the convert answers carry and the ones the user confirmed for a flagged quote. */
  tokenConversionFloors?: Readonly<Record<string, TokenConversionFloor>>;
  conversionImpactAcknowledgedFor?: Readonly<Record<string, string>>;
}): boolean {
  const { conversions, balanceBearingCount, dispositions, transferDestinations } = input;
  const floors = input.tokenConversionFloors ?? {};
  const confirmed = input.conversionImpactAcknowledgedFor ?? {};

  if (balanceBearingCount > 0 && conversions.length === 0) return false;

  return conversions.every((c) => {
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
        isConversionImpactConfirmed(c.asset, floors, confirmed)
      );
    }
    return c.convertible || dispositions[c.asset] === "issuer";
  });
}
