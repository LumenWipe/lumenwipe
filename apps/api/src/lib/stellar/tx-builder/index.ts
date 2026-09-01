import type {
  AccountState,
  AssetDisposition,
  ClaimableBalanceSelection,
  DefiPositionsResult,
  PlannedStep,
  StepType,
  BuildPlanResult,
  PlanBlocker,
  SponsoredEntry,
  TransferDestinations,
  Trustline,
} from "@lumenwipe/types";
import type { SponsorshipAffordability } from "@/lib/stellar/sponsorship-affordability";
import { assessDefiPositionsGate } from "@/lib/defi-positions/positions-gate";
import { estimateFeeLumens } from "@/lib/utils/amounts";
import { batchItems } from "./batching";
import { OP_BATCH_LIMIT } from "@/config/constants";

function shortAddr(addr: string): string {
  return `${addr.slice(0, 8)}…${addr.slice(-8)}`;
}

function describeSponsoredEntry(entry: SponsoredEntry): string {
  switch (entry.kind) {
    case "account":
      return "an account creation";
    case "trustline":
      return `a trustline for ${entry.asset.split(":")[0]}`;
    case "offer":
      return `offer ${entry.offerId}`;
    case "data_entry":
      return `data entry "${entry.name}"`;
    case "signer":
      return "a signer";
    case "claimable_balance":
      return "a claimable balance";
  }
}

/**
 * What the plan tells the user this asset's step will do.
 *
 * The plan is the informed-consent surface: it is the last thing the user reads before signing
 * an irreversible close, so a step must describe the disposition actually chosen rather than the
 * one that happens to be the default. An asset with no disposition yet - a caller that predates
 * them, or a decision the user has not made - keeps the conversion wording the app offers by
 * default.
 */
function assetStepLabels(
  tl: Trustline,
  disposition: AssetDisposition | undefined,
  destination: string | undefined
): { title: string; description: string } {
  if (disposition === "issuer") {
    return {
      title: `Return ${tl.code} to issuer`,
      description: `Send ${tl.balance} ${tl.code} back to its issuer. You give up these tokens.`,
    };
  }
  if (disposition === "transfer") {
    // A transfer answer that carries no usable destination is bounced back to the caller as a
    // pending decision, so this only renders mid-decision - but naming no account is still the
    // only honest thing to say here, and it beats interpolating `undefined` into the copy.
    if (destination === undefined) {
      return {
        title: `Send ${tl.code} to another account`,
        description: `Send ${tl.balance} ${tl.code} to another account that already holds the trustline.`,
      };
    }
    return {
      title: `Send ${tl.code} to ${shortAddr(destination)}`,
      description: `Send ${tl.balance} ${tl.code} to ${shortAddr(destination)}, which already holds the trustline.`,
    };
  }
  return {
    title: `Convert ${tl.code} to XLM`,
    description: `Exchange ${tl.balance} ${tl.code} for XLM via the Stellar DEX.`,
  };
}

function step(
  index: number,
  type: StepType,
  title: string,
  description: string,
  operationCount: number,
  extra?: Partial<PlannedStep>
): PlannedStep {
  return {
    index,
    type,
    title,
    description,
    operationCount,
    estimatedFeeLumens: estimateFeeLumens(operationCount),
    txXdr: null,
    status: "pending",
    txHash: null,
    error: null,
    ...extra,
  };
}

export function computeNeedsSignerNormalization(accountState: AccountState): boolean {
  const extraSigners = accountState.signers.filter((s) => s.key !== accountState.address);
  return (
    extraSigners.length > 0 || accountState.thresholds.med > 1 || accountState.thresholds.high > 1
  );
}

export function buildPlan(
  accountState: AccountState,
  mediatorRequired: boolean,
  fastPathEligible = false,
  claimableBalanceSelections: Record<string, ClaimableBalanceSelection> = {},
  sponsorshipAffordability: SponsorshipAffordability = {
    revocable: [],
    unaffordableOwners: new Map(),
  },
  /** The user's per-asset choice, keyed by the canonical `CODE:ISSUER` asset string. Only the
   *  step's wording depends on it - which assets need a step at all does not. */
  dispositions: Record<string, AssetDisposition> = {},
  /** Where each `transfer` disposition pays, keyed the same way. */
  transferDestinations: TransferDestinations = {},
  /** The account's normalized DeFi position read (issue #146), when the caller has one. Null
   *  until whatever wires OctoPos into the request pipeline supplies it - see
   *  assessDefiPositionsGate for what a non-null result is gated on. */
  defiPositions: DefiPositionsResult | null = null
): BuildPlanResult {
  const steps: PlannedStep[] = [];
  const blockers: PlanBlocker[] = [];
  let idx = 0;

  const {
    signers,
    thresholds,
    dataEntries,
    openOffers,
    trustlines,
    claimableBalances,
    authImmutable,
  } = accountState;
  const masterKey = accountState.address;
  const extraSigners = signers.filter((s) => s.key !== masterKey);

  // AUTH_IMMUTABLE: ACCOUNT_MERGE is permanently blocked regardless of other state.
  // SetOptions is also disabled, so NORMALIZE_SIGNERS would fail too. Surface this
  // as the first blocker so users don't read past a plan that can never execute.
  if (authImmutable) {
    blockers.push({
      message:
        "This account has the AUTH_IMMUTABLE flag set. ACCOUNT_MERGE is permanently disabled " +
        "for AUTH_IMMUTABLE accounts - the flag cannot be cleared once set.",
    });
  }

  // Sponsoring: numSponsoring > 0 means this account is the reserve sponsor for entries on
  // other accounts. Per-owner affordability (computed by the caller via
  // assessSponsorshipAffordability, since it requires a live on-chain read) decides step vs.
  // blocker for each owner - this is the actual fix for the bug this replaces (an unconditional
  // blocker regardless of whether the sponsored owner could actually absorb the reserve).
  //
  // Falls back to the old blanket blocker whenever the enumeration behind sponsoredEntries is
  // admittedly incomplete (no partial resolution against a list that might be missing entries),
  // or - defensively - whenever numSponsoring disagrees with what was actually enumerated (an
  // enumeration bug should never silently read as "sponsors nothing").
  const noEntriesFound = accountState.sponsoredEntries.length === 0;
  const sponsorshipUsesBlanketBlocker =
    accountState.numSponsoring > 0 &&
    (accountState.sponsorshipEnumerationIncomplete || noEntriesFound);
  if (sponsorshipUsesBlanketBlocker) {
    blockers.push({
      message:
        `This account is sponsoring ${accountState.numSponsoring} entr${accountState.numSponsoring === 1 ? "y" : "ies"} ` +
        `on other accounts. All sponsorships must be revoked before the account can be merged.`,
    });
  } else {
    // Claimable balances can never be self-revoked (CAP-33 requires a cooperating new
    // sponsor this close flow cannot arrange) - always a permanent blocker, independent of
    // affordability.
    for (const entry of accountState.sponsoredEntries) {
      if (entry.kind !== "claimable_balance") continue;
      blockers.push({
        code: "sponsorship_claimable_balance_unrevocable",
        message:
          "This account sponsors a claimable balance, which cannot be revoked without a " +
          "cooperating new sponsor. It resolves automatically once a claimant claims the " +
          "balance - there is no self-service action to take here.",
      });
    }
    for (const [owner, info] of sponsorshipAffordability.unaffordableOwners) {
      for (const entry of info.entries) {
        blockers.push({
          code: "sponsorship_unaffordable",
          message:
            `Revoking sponsorship of ${describeSponsoredEntry(entry)} on ${shortAddr(owner)} would ` +
            `leave that account below its minimum balance - it needs ${info.shortfallXlm} more XLM first.`,
        });
      }
    }
  }

  // Pool share blocker: liquidity pool share trustlines cost 2 base reserves each and must
  // be withdrawn from the pool (via a DEX UI) before the trustline can be removed.
  if (accountState.poolShares.length > 0) {
    blockers.push({
      message:
        `This account holds ${accountState.poolShares.length} liquidity pool share(s). ` +
        `Withdraw from the pool using a DEX interface (e.g. Stellar Expert) before continuing.`,
    });
  }

  // Sub-entry mismatch blocker: we enumerated fewer sub-entries than the ledger reports.
  // Proceeding would leave unknown entries behind - block rather than build an incomplete plan.
  if (accountState.subEntryMismatch) {
    blockers.push({
      message:
        "This account has entries that could not be enumerated. " +
        "The analysis may be incomplete - do not proceed until the discrepancy is resolved.",
    });
  }

  // DeFi position freshness/confidence gate (issue #147): same "don't guess" treatment as the
  // sub-entry mismatch above, applied to OctoPos's own signals. A no-op until a caller actually
  // supplies a DefiPositionsResult - see assessDefiPositionsGate for what triggers a blocker.
  if (defiPositions) {
    blockers.push(...assessDefiPositionsGate(defiPositions));
  }

  // Threshold gating: SetOptions is a HIGH-threshold operation. If no combination of
  // this app's satisfiable signers can reach the current high threshold, the normalization
  // tx can never be authorized - surface this as a blocker before building a plan that
  // would fail at signing time.
  const needsSignerNormalization = computeNeedsSignerNormalization(accountState);

  if (needsSignerNormalization) {
    // signerNormalizationOps() (signers.ts) always removes every non-master signer and resets
    // thresholds to 0/1/1 - it never raises masterWeight. If the master key's own weight is 0,
    // normalization would strip away every other signer and leave an account with a weight-0
    // master key and threshold 1: nothing left able to authorize anything, ever. This is
    // independent of the combined-weight check below - block it up front regardless of how
    // much weight the co-signers carry.
    const masterWeight = signers.find((s) => s.key === masterKey)?.weight ?? 0;
    if (masterWeight < 1) {
      blockers.push({
        message:
          "The master key on this account has weight 0. Removing the account's other signers " +
          "would leave no key able to authorize any further changes to this account, so this " +
          "flow cannot safely proceed.",
      });
    }

    // Combined weight, not the master key's alone: the signature-accumulation engine
    // (multisig epic #97) can gather a normalization/merge signature from any signer whose
    // type this app can actually satisfy - ed25519 (connected wallet or secret key), hash(x)
    // (manual preimage), or pre-auth-tx (manual pre-authorized transaction) - matching
    // apps/web/components/execution/SigningProgress.tsx's own satisfiable-weight reasoning,
    // applied here before the guided UI ever reaches the signing step. An ed25519
    // signed-payload signer's weight never counts: this flow has no path to satisfy one.
    const satisfiableWeight = signers
      .filter(
        (s) => s.type === "ed25519_public_key" || s.type === "hash_x" || s.type === "preauth_tx"
      )
      .reduce((sum, s) => sum + s.weight, 0);
    if (satisfiableWeight < thresholds.high) {
      const totalWeight = signers.reduce((sum, s) => sum + s.weight, 0);
      const message =
        satisfiableWeight === totalWeight
          ? `This account's signers can contribute at most weight ${satisfiableWeight} toward removing ` +
            `signers or changing thresholds, but that requires weight ${thresholds.high} (the current ` +
            `high threshold).`
          : `This account's signers can contribute at most weight ${satisfiableWeight} toward removing ` +
            `signers or changing thresholds, but that requires weight ${thresholds.high} (the current ` +
            `high threshold). At least one of its signers cannot be authorized through this flow, so this ` +
            `change can never be fully authorized.`;
      blockers.push({ message });
    }
  }

  // Deauthorized trustlines with balance: the issuer has revoked authorization on these
  // trustlines. PathPaymentStrictSend fails with src_not_authorized, and ChangeTrust
  // limit=0 fails while balance > 0. The issuer must re-authorize before the account
  // can convert or remove these trustlines.
  const deauthorizedWithBalance = trustlines.filter(
    (tl) => !tl.authorized && parseFloat(tl.balance) > 0
  );
  for (const tl of deauthorizedWithBalance) {
    blockers.push({
      message:
        `Trustline for ${tl.code} has a non-zero balance (${tl.balance}) but is deauthorized ` +
        `by the issuer. The issuer must re-authorize this trustline before it can be ` +
        `converted or removed.`,
    });
  }

  // Claimable balances: each resolves to a per-balance selection - "claim" (the opt-out
  // default once the account can already claim it), "add_trustline_then_claim" (adds a
  // trustline for the asset, then claims - the remediation path for a balance the account
  // holds no trustline for), or "forfeit". A balance the account cannot currently claim and
  // has no selection remains a hard blocker; an explicit forfeit still surfaces a warning
  // (differently worded, and non-trapping - see close.controller.ts's blocker-code handling)
  // so giving up the funds is never silent.
  const authorizedTrustlineAssets = new Set(
    trustlines.filter((tl) => tl.authorized).map((tl) => tl.asset)
  );
  const isCurrentlyClaimable = (b: (typeof claimableBalances)[number]): boolean =>
    b.asset === "native" || authorizedTrustlineAssets.has(b.asset);

  for (const b of claimableBalances) {
    if (isCurrentlyClaimable(b)) continue;
    const code = b.asset.split(":")[0];
    const selection = claimableBalanceSelections[b.id];
    if (selection === "add_trustline_then_claim") continue;
    if (selection === "forfeit") {
      blockers.push({
        code: "claimable_balance_forfeited",
        message: `You chose to forfeit ${b.amount} ${code}; it will be permanently inaccessible once the account is merged.`,
      });
      continue;
    }
    blockers.push({
      code: "claimable_balance_unclaimable",
      message:
        `This account is a claimant for ${b.amount} ${code} but has no authorized trustline ` +
        `for it. Establish a ${code} trustline and claim the balance manually before proceeding ` +
        `- these funds will be permanently inaccessible once the account is merged.`,
    });
  }

  // Balances that will actually need an operation: currently-claimable ones not explicitly
  // forfeited (the opt-out default), plus not-currently-claimable ones the caller chose to
  // remediate. Forfeited/unresolved balances need no operation at all - they're simply left
  // behind. Reused by both the fast-path gate below and step generation further down.
  const balancesNeedingClaimStep = claimableBalances.filter((b) =>
    isCurrentlyClaimable(b)
      ? claimableBalanceSelections[b.id] !== "forfeit"
      : claimableBalanceSelections[b.id] === "add_trustline_then_claim"
  );
  const balancesNeedingTrustline = claimableBalances.filter(
    (b) =>
      !isCurrentlyClaimable(b) && claimableBalanceSelections[b.id] === "add_trustline_then_claim"
  );

  // ─── Fast path: fuse the whole close into one transaction when eligible ──────
  // Direct destination: a single CLOSE_ACCOUNT (cleanup + merge). Exchange: a fused
  // cleanup CLOSE_ACCOUNT plus the co-signed mediator MERGE. Excluded when any
  // blocker exists, when claimable balances are present (those route through the
  // step-by-step CLAIM_BALANCES flow so their proceeds are not lost), or when the
  // fused tx would exceed the per-transaction operation limit. Conversion fuses
  // while it is classic; it moves to its own isolated transaction once swaps
  // execute via the Soroswap aggregator (a Soroban op that cannot share a tx).
  const convertible = trustlines.filter((tl) => tl.authorized && parseFloat(tl.balance) > 0);
  const hasCleanup =
    needsSignerNormalization ||
    dataEntries.length > 0 ||
    openOffers.length > 0 ||
    trustlines.length > 0;
  const signerOps = needsSignerNormalization ? extraSigners.length + 1 : 0;
  const fusedOpCount =
    signerOps + dataEntries.length + openOffers.length + convertible.length + trustlines.length + 1;

  // A forfeited-balance blocker is an acknowledged warning, not a hard stop (the user already
  // chose to give up those funds) - every other blocker code still excludes the fast path.
  const hasHardBlocker = blockers.some((b) => b.code !== "claimable_balance_forfeited");

  if (
    fastPathEligible &&
    hasCleanup &&
    !hasHardBlocker &&
    balancesNeedingClaimStep.length === 0 &&
    accountState.sponsoredEntries.length === 0 &&
    fusedOpCount <= OP_BATCH_LIMIT
  ) {
    const cleanupOps = fusedOpCount - 1; // ops without the merge
    steps.push(
      step(
        idx++,
        "CLOSE_ACCOUNT",
        mediatorRequired ? "Clean up account" : "Close account",
        mediatorRequired
          ? "Remove signers, data, offers, and trustlines, and convert balances to XLM, in one transaction. The merge to your exchange address follows as a co-signed transfer."
          : "Remove signers, data, offers, and trustlines, convert balances to XLM, and merge the account, all in one transaction.",
        mediatorRequired ? cleanupOps : fusedOpCount
      )
    );
    if (mediatorRequired) {
      steps.push(
        step(
          // Stryker disable next-line UpdateOperator: the last use of `idx` in this branch (the
          // function returns right after) - post-increment and post-decrement both yield the
          // same value here, and nothing reads `idx` again afterward to see the difference.
          idx++,
          "MERGE",
          "Merge and forward to exchange",
          "Close this account and forward the full balance to your exchange deposit address in one atomic transaction, routed through a shared intermediary.",
          2
        )
      );
    }
    return { steps, blockers };
  }

  // ─── Step generation ────────────────────────────────────────────────────────

  if (needsSignerNormalization) {
    steps.push(
      step(
        idx++,
        "NORMALIZE_SIGNERS",
        "Remove extra signers",
        `Remove ${extraSigners.length} additional signer(s) and reset authorization thresholds so this key alone can authorize transactions.`,
        extraSigners.length + 1
      )
    );
  }

  // Stryker disable next-line EqualityOperator,ConditionalExpression: batchItems([], N) always
  // returns [], so the loop below runs zero times regardless of this gate - it is an early exit,
  // not behavior. Removing it changes nothing observable.
  if (!sponsorshipUsesBlanketBlocker && sponsorshipAffordability.revocable.length > 0) {
    const batches = batchItems(sponsorshipAffordability.revocable, OP_BATCH_LIMIT);
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      steps.push(
        step(
          idx++,
          "REVOKE_SPONSORSHIP",
          batches.length > 1
            ? `Revoke sponsorships (batch ${i + 1}/${batches.length})`
            : "Revoke sponsorships",
          `Transfer reserve responsibility for ${batch.length} sponsored entr${batch.length === 1 ? "y" : "ies"} back to their own accounts.`,
          batch.length
        )
      );
    }
  }

  // Stryker disable next-line EqualityOperator,ConditionalExpression: batchItems([], N) always
  // returns [], so the loop below runs zero times regardless of this gate.
  if (dataEntries.length > 0) {
    const batches = batchItems(dataEntries, OP_BATCH_LIMIT);
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      steps.push(
        step(
          idx++,
          "REMOVE_DATA_ENTRIES",
          batches.length > 1
            ? `Remove data entries (batch ${i + 1}/${batches.length})`
            : "Remove data entries",
          `Clear ${batch.length} data entr${batch.length === 1 ? "y" : "ies"} stored on this account.`,
          batch.length
        )
      );
    }
  }

  // Stryker disable next-line EqualityOperator,ConditionalExpression: batchItems([], N) always
  // returns [], so the loop below runs zero times regardless of this gate.
  if (openOffers.length > 0) {
    const batches = batchItems(openOffers, OP_BATCH_LIMIT);
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      steps.push(
        step(
          idx++,
          "CANCEL_OFFERS",
          batches.length > 1
            ? `Cancel DEX offers (batch ${i + 1}/${batches.length})`
            : "Cancel open DEX offers",
          `Cancel ${batch.length} open offer${batch.length === 1 ? "" : "s"} on the Stellar DEX.`,
          batch.length
        )
      );
    }
  }

  // Balances that need a trustline added before they can be claimed (the remediation path).
  // Always emitted immediately before the CLAIM_BALANCES step so the claim never runs against
  // a still-untrusted asset.
  // Stryker disable next-line EqualityOperator,ConditionalExpression: batchItems([], N) always
  // returns [], so the loop below runs zero times regardless of this gate.
  // Batched by unique asset: the transaction adds one trustline per asset (see
  // trustlineAddForClaimOps), so the step count and fee estimate must match.
  const assetsNeedingTrustline = [...new Set(balancesNeedingTrustline.map((b) => b.asset))];
  if (assetsNeedingTrustline.length > 0) {
    const batches = batchItems(assetsNeedingTrustline, OP_BATCH_LIMIT);
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      steps.push(
        step(
          idx++,
          "ADD_TRUSTLINE_FOR_CLAIM",
          batches.length > 1
            ? `Add trustlines to claim (batch ${i + 1}/${batches.length})`
            : "Add trustlines to claim",
          `Establish ${batch.length} trustline${batch.length === 1 ? "" : "s"} so the following claimable balance${batch.length === 1 ? "" : "s"} can be claimed.`,
          batch.length
        )
      );
    }
  }

  // Claimable balances the caller resolved to actually claim: currently-claimable ones not
  // opted out, plus ones just remediated with a new trustline above. Batched like other
  // operations. Excludes forfeited/unresolved balances entirely.
  const claimable = balancesNeedingClaimStep;
  // Stryker disable next-line EqualityOperator,ConditionalExpression: batchItems([], N) always
  // returns [], so the loop below runs zero times regardless of this gate.
  if (claimable.length > 0) {
    const batches = batchItems(claimable, OP_BATCH_LIMIT);
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const xlmCount = batch.filter((b) => b.asset === "native").length;
      const tokenCount = batch.length - xlmCount;
      let detail = "";
      if (xlmCount > 0 && tokenCount > 0) {
        detail = ` (${xlmCount} XLM, ${tokenCount} token${tokenCount === 1 ? "" : "s"})`;
      } else if (tokenCount > 0) {
        detail = ` (${tokenCount} token${tokenCount === 1 ? "" : "s"})`;
      }
      steps.push(
        step(
          idx++,
          "CLAIM_BALANCES",
          batches.length > 1
            ? `Claim balances (batch ${i + 1}/${batches.length})`
            : "Claim claimable balances",
          `Claim ${batch.length} claimable balance${batch.length === 1 ? "" : "s"}${detail} and add the proceeds to this account.`,
          batch.length
        )
      );
    }
  }

  // HANDLE_ASSETS: include trustlines with a current balance OR whose asset appears
  // in a claimable balance that will be claimed above - claiming runs first and increases
  // the live trustline balance, which the executor reads on-chain at step build time.
  const claimableNonXlmByAsset = new Map<string, number>();
  for (const b of claimable) {
    // Stryker disable next-line ConditionalExpression,StringLiteral: a Trustline's `asset` is
    // never the string "native" (native XLM is never represented as a trustline - it's the
    // account's own base balance), so a key of "native" wrongly added here could never be
    // looked up by `trustlinesNeedingAction`'s `claimableNonXlmByAsset.get(tl.asset)` below.
    // Unobservable given that domain invariant.
    if (b.asset !== "native") {
      claimableNonXlmByAsset.set(
        b.asset,
        (claimableNonXlmByAsset.get(b.asset) ?? 0) + parseFloat(b.amount)
      );
    }
  }

  // Balances arriving through a trustline this plan itself adds. They exist in no trustline
  // yet, so the filter above cannot see them - but after the claim round they are a balance
  // like any other, and the merge fails while they sit there. Leaving them out is what made
  // the plan read "add trustline -> claim -> merge": a close the network would reject, and one
  // that dead-ended a round later asking for a disposition the caller was never offered.
  // Balance "0" on purpose: on-chain the line really does start empty and the claim fills it,
  // which is exactly what the effective-amount calculation below already models for a line the
  // account holds today. One path, no special case, no double count.
  //
  // One synthetic line per ASSET: several claimable balances can share one, and mapping them
  // one-to-one produced two HANDLE_ASSETS steps each labeled with the doubled total and a
  // REMOVE_TRUSTLINES batch deleting the same line twice - which fails on-chain at the second
  // op and takes the whole close round with it.
  const arrivingByClaim: Trustline[] = [
    ...new Set(balancesNeedingTrustline.map((b) => b.asset)),
  ].map((asset) => ({
    asset,
    balance: "0",
    authorized: true,
    issuer: asset.split(":")[1] ?? "",
    code: asset.split(":")[0],
  }));

  const trustlinesNeedingAction = [
    ...trustlines.filter(
      (tl) =>
        tl.authorized &&
        (parseFloat(tl.balance) > 0 || (claimableNonXlmByAsset.get(tl.asset) ?? 0) > 0)
    ),
    ...arrivingByClaim,
  ];

  for (const tl of trustlinesNeedingAction) {
    // The amount the step will actually move, not the one sitting there while the plan is read.
    // A line the claim tops up shows 0 today, and "Exchange 0.0000000 EURC for XLM" describes
    // neither what the user chose nor what will happen.
    const arriving = claimableNonXlmByAsset.get(tl.asset) ?? 0;
    const effective =
      arriving > 0 ? { ...tl, balance: (parseFloat(tl.balance) + arriving).toFixed(7) } : tl;
    const { title, description } = assetStepLabels(
      effective,
      dispositions[tl.asset],
      transferDestinations[tl.asset]
    );
    steps.push(step(idx++, "HANDLE_ASSETS", title, description, 1, { affectedAsset: tl.asset }));
  }

  // Every trustline the account will hold when the merge runs, including the ones this plan
  // adds to reach a claimable balance. A trustline the plan created is still a trustline the
  // merge trips over, so it has to come off in the same close.
  const trustlinesToRemove = [...trustlines, ...arrivingByClaim];

  // Stryker disable next-line EqualityOperator,ConditionalExpression: batchItems([], N) always
  // returns [], so the loop below runs zero times regardless of this gate.
  if (trustlinesToRemove.length > 0) {
    const batches = batchItems(trustlinesToRemove, OP_BATCH_LIMIT);
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      steps.push(
        step(
          idx++,
          "REMOVE_TRUSTLINES",
          batches.length > 1
            ? `Remove trustlines (batch ${i + 1}/${batches.length})`
            : "Remove trustlines",
          `Remove ${batch.length} trustline${batch.length === 1 ? "" : "s"} to recover the base reserve.`,
          batch.length
        )
      );
    }
  }

  steps.push(
    step(
      // Stryker disable next-line UpdateOperator: the last use of `idx` in the function (return
      // follows immediately) - post-increment and post-decrement both yield the same value here.
      idx++,
      "MERGE",
      mediatorRequired ? "Merge and forward to exchange" : "Merge account",
      mediatorRequired
        ? "Close this account and forward the full balance to your exchange deposit address in one atomic transaction, routed through a shared intermediary. You recover essentially all of your XLM; only standard network fees apply."
        : "Merge this account, transferring the XLM balance to the destination account and removing it from the Stellar ledger.",
      mediatorRequired ? 2 : 1
    )
  );

  return { steps, blockers };
}
