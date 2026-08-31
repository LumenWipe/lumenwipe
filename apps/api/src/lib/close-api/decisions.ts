import type {
  AccountState,
  AssetDisposition,
  ClaimableBalanceSelection,
  DecisionAnswer,
  DecisionPoint,
  TransferDestinations,
} from "@lumenwipe/types";
import { StrKey } from "@stellar/stellar-sdk";
import { lookupExchange } from "@/lib/exchange-registry";

/**
 * Stable id for the unrecognized-destination acknowledgement, scoped to the address it is
 * about: "destination:G...". The scoping is the point. An answer carries only an id and a
 * choice (`DecisionAnswer`), so an id that did not name the address would make the
 * acknowledgement a bare boolean a caller could carry from one destination to another - the
 * caller confirms control of a wallet, then edits the destination to an exchange deposit
 * address and resends the same answers, and the gate below waves it through. Scoping by
 * address makes that structurally impossible, and matches how every other decision here is
 * keyed (`assetDecisionId`, `claimableBalanceDecisionId`).
 */
export function destinationDecisionId(address: string): string {
  return `destination:${address}`;
}

// The only choice that resolves it. Naming it after what the caller is asserting, rather
// than a generic "acknowledged", keeps the claim legible in an API log or an SDK call site.
export const DESTINATION_ACK_CHOICE = "i_control_this_address";

// Derives the acknowledgement required when the destination is not in the exchange registry.
//
// Absence from the registry is not evidence that an address is a personal wallet - the registry
// holds 20 curated deposit addresses, so every address any exchange issues from here on is
// unrecognized by default. Treating "unknown" as "personal wallet" is what makes a direct
// ACCOUNT_MERGE into an exchange deposit address possible, and exchanges credit only Payment
// operations carrying a memo: the merge succeeds on-chain and the funds are never credited to
// anyone. There is no error, and the source account no longer exists to investigate from.
//
// We cannot tell an exchange address from a personal one, so the only party who can resolve this
// is the caller, who knows where the address came from. No default: like a claimable balance the
// account cannot yet claim, this is never silently resolved.
export function deriveDestinationDecisionPoints(destination: string | null): DecisionPoint[] {
  if (!destination || lookupExchange(destination) !== null) return [];
  return [
    {
      id: destinationDecisionId(destination),
      type: "confirmation" as const,
      subject: { kind: "destination", address: destination },
      options: [
        {
          id: DESTINATION_ACK_CHOICE,
          note:
            "This address is a wallet you control. Closing directly into an exchange or custodial " +
            "deposit address loses the funds: exchanges credit deposits from payments carrying a " +
            "memo, and cannot credit an account merge.",
        },
      ],
      default: "",
      required: true,
    },
  ];
}

// True when the caller has explicitly asserted control of THIS destination. Defaults to false
// on a missing, malformed, or differently-addressed answer - silence is not consent, and
// neither is consent given for some other address. Element-level optional chaining because
// `decisions` reaches here as an unvalidated array from the request body.
export function isDestinationAcknowledged(answers: DecisionAnswer[], destination: string): boolean {
  const id = destinationDecisionId(destination);
  return answers.some((a) => a?.id === id && a?.choice === DESTINATION_ACK_CHOICE);
}

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

/**
 * The non-native amounts the close will claim, summed per asset.
 *
 * The will-it-be-claimed rule is buildPlan's, restated: a currently-claimable balance is
 * claimed unless explicitly forfeited, and one the account cannot claim yet is claimed only on
 * an explicit `add_trustline_then_claim`. Everything downstream that reasons about "the balance
 * this asset will hold after the claims run" - decision derivation, convertibility pricing, the
 * transactions-endpoint gate - shares this so the layers cannot disagree about which assets
 * exist.
 */
export function claimedAmountsPerAsset(
  account: Pick<AccountState, "trustlines" | "claimableBalances">,
  claimableBalanceSelections: Record<string, ClaimableBalanceSelection>
): Map<string, number> {
  const authorized = new Set(
    account.trustlines.filter((tl) => tl.authorized).map((tl) => tl.asset)
  );
  const perAsset = new Map<string, number>();
  for (const b of account.claimableBalances) {
    if (b.asset === "native") continue;
    const selection = claimableBalanceSelections[b.id];
    const willClaim = isCurrentlyClaimable(b.asset, authorized)
      ? selection !== "forfeit"
      : selection === "add_trustline_then_claim";
    if (!willClaim) continue;
    perAsset.set(b.asset, (perAsset.get(b.asset) ?? 0) + parseFloat(b.amount));
  }
  return perAsset;
}

// Derives the per-asset disposition decisions the caller must resolve before a close
// can be built. `convertibility[asset]` is the best-effort result of path finding:
// true when a DEX route to XLM exists, false otherwise. Only trustlines holding a
// balance need a decision; empty trustlines are simply removed.
export function deriveDecisionPoints(
  account: AccountState,
  convertibility: Record<string, boolean>,
  /** The caller's claimable-balance answers. A balance being claimed through a *new* trustline
   *  puts an asset in the account that no trustline represents yet, and that asset needs a
   *  disposition like any other - without one the close dead-ends after the claim round, with
   *  the trustline already added and the balance already claimed. */
  claimableBalanceSelections: Record<string, ClaimableBalanceSelection> = {}
): DecisionPoint[] {
  // What each claim will add, summed per asset - the same will-it-be-claimed rule buildPlan
  // uses: a currently-claimable balance is claimed unless explicitly forfeited (claiming is the
  // opt-out default), and one the account cannot claim yet is claimed only when the caller
  // chose to remediate. Keyed by asset so several balances of one asset decide it once, with
  // the total - two decision points sharing an id rendered doubled cards and let one answer
  // satisfy both.
  const claimedPerAsset = claimedAmountsPerAsset(account, claimableBalanceSelections);

  // One entry per asset that will hold a positive balance once the claims run. A trustline
  // with a balance today is decided regardless; a zero-balance line filled by a claim, and a
  // line the plan itself will add, are decided by what arrives - each was previously decided
  // NOWHERE (the arriving branch excluded trusted assets, the trustline branch excluded zero
  // balances), so the close 422'd at round 2 for an answer the caller was never asked for.
  const pendingByAsset = new Map<string, { asset: string; balance: string }>();
  for (const tl of account.trustlines) {
    const arriving = claimedPerAsset.get(tl.asset) ?? 0;
    const total = Number(tl.balance) + arriving;
    if (total > 0) {
      pendingByAsset.set(tl.asset, { asset: tl.asset, balance: total.toFixed(7) });
    }
  }
  for (const [asset, amount] of claimedPerAsset) {
    if (!pendingByAsset.has(asset)) {
      pendingByAsset.set(asset, { asset, balance: amount.toFixed(7) });
    }
  }
  const pending = [...pendingByAsset.values()];

  return pending.map((tl) => {
    const convertible = convertibility[tl.asset] ?? false;
    // Transferring needs no conversion route, so it is offered whether or not the asset is
    // convertible - for an asset with no market it is the only option that does not destroy
    // the balance. It is never the default: it is the one choice that cannot be resolved
    // without an address the caller has to supply.
    const transferOption = {
      id: TRANSFER_CHOICE,
      note: "Sends the balance, as this asset, to an account that already holds its trustline.",
    };
    const options = convertible
      ? [
          { id: "convert_to_xlm", recommended: true },
          {
            id: "return_to_issuer",
            note: "Sends the balance back to the issuer; you receive no XLM.",
          },
          transferOption,
        ]
      : [
          {
            id: "return_to_issuer",
            note: "No conversion route exists; the balance is returned to the issuer.",
          },
          transferOption,
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
    else if (answer.choice === TRANSFER_CHOICE) out[asset] = "transfer";
  }
  return out;
}

/** The choice id that selects the transfer disposition. */
export const TRANSFER_CHOICE = "transfer_to_account";

/** Raised when a transfer answer carries no usable destination. Caught at the controller
 *  boundary and surfaced as a 422 naming the asset, never defaulted. */
export class MissingTransferDestinationError extends Error {
  constructor(readonly asset: string) {
    super(
      `Choosing to transfer ${asset} requires the account to send it to. ` +
        `Provide params.destination as a G... address on the answer for this asset.`
    );
    this.name = "MissingTransferDestinationError";
  }
}

/**
 * Collects the per-asset destinations that transfer answers carry.
 *
 * Deliberately strict rather than lenient. Everywhere else here an unusable answer falls back to
 * a safe default, but there is no safe default for this one: converting or returning to the
 * issuer both destroy the balance the caller explicitly asked to keep, and silently doing either
 * is the failure mode the "never silently skipped" invariant exists to prevent. So a transfer
 * choice with a missing or malformed destination refuses the whole request instead.
 *
 * Only the shape is checked here - that the address is a well-formed ed25519 public key. Whether
 * the account exists, holds the trustline, and has limit headroom needs live state, so it is
 * validated against the ledger just before building.
 */
export function resolveTransferDestinations(
  answers: DecisionAnswer[],
  assetsById: { id: string; asset: string }[]
): TransferDestinations {
  const { destinations, missing } = collectTransferDestinations(answers, assetsById);
  const first = missing[0];
  if (first !== undefined) throw new MissingTransferDestinationError(first);
  return destinations;
}

/**
 * The non-throwing form: every destination that resolved, and every asset whose transfer answer
 * had no usable one.
 *
 * The plan needs this shape. Throwing on the first bad answer there meant one typo suppressed
 * the live-ledger check for every other destination in the same close, so a caller fixed one
 * problem, re-planned, and only then discovered the next.
 *
 * Scoped to the *resolved* disposition, not to any answer that ever said `transfer`. Answers are
 * last-wins, so a caller who selects transfer and then switches the asset to convert leaves a
 * stale transfer answer in the array; keying off that would refuse a perfectly valid
 * convert-only close, or validate a destination nothing is being paid to.
 */
export function collectTransferDestinations(
  answers: DecisionAnswer[],
  assetsById: { id: string; asset: string }[]
): { destinations: TransferDestinations; missing: string[] } {
  const assetForId = new Map(assetsById.map((a) => [a.id, a.asset]));
  const dispositions = resolveDispositions(answers, assetsById);
  const destinations: TransferDestinations = {};
  const missing: string[] = [];

  for (const answer of answers) {
    if (answer?.choice !== TRANSFER_CHOICE) continue;
    const asset = assetForId.get(answer.id);
    if (asset === undefined) continue;
    if (dispositions[asset] !== "transfer") continue;

    const destination = answer.params?.destination;
    if (!destination || !StrKey.isValidEd25519PublicKey(destination)) {
      if (!missing.includes(asset)) missing.push(asset);
      continue;
    }
    destinations[asset] = destination;
  }
  // A later valid answer for the same asset clears an earlier malformed one.
  return { destinations, missing: missing.filter((asset) => destinations[asset] === undefined) };
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
    const ownPredicate = b.claimants.find((c) => c.destination === account.address)?.predicate ?? {
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
