import type { AccountState } from "@/types/account";
import type { PlannedStep, StepType, BuildPlanResult, PlanBlocker } from "@/types/plan";
import { estimateFeeLumens } from "@/lib/utils/amounts";
import { batchItems } from "./batching";
import { OP_BATCH_LIMIT } from "@/config/constants";

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
  fastPathEligible = false
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

  // Sponsoring blocker: numSponsoring > 0 means this account is the reserve sponsor for
  // entries on other accounts (including claimable balances it created). stellar-core
  // refuses ACCOUNT_MERGE when numSponsoring > 0.
  if (accountState.numSponsoring > 0) {
    blockers.push({
      message:
        `This account is sponsoring ${accountState.numSponsoring} entr${accountState.numSponsoring === 1 ? "y" : "ies"} ` +
        `on other accounts. All sponsorships must be revoked before the account can be merged.`,
    });
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

  // Threshold gating: SetOptions is a HIGH-threshold operation. If the master
  // key's weight alone cannot reach the current high threshold, the normalization
  // tx can never be self-authorized - surface this as a blocker before building a
  // plan that would fail at signing time.
  const needsSignerNormalization = computeNeedsSignerNormalization(accountState);

  if (needsSignerNormalization) {
    const masterSigner = signers.find((s) => s.key === masterKey);
    const masterWeight = masterSigner?.weight ?? 0;
    if (masterWeight < thresholds.high) {
      blockers.push({
        message:
          `The master key has weight ${masterWeight}, but removing signers or changing thresholds ` +
          `requires weight ${thresholds.high} (the current high threshold). ` +
          `A hash preimage or pre-authorized transaction is needed to authorize this change. ` +
          `This flow supports single-key authorization only.`,
      });
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

  // Claimable balances without a trustline: the account is a claimant but cannot claim
  // because no authorized trustline exists for the asset. After ACCOUNT_MERGE the
  // account no longer exists, making these assets permanently inaccessible.
  const authorizedTrustlineAssets = new Set(
    trustlines.filter((tl) => tl.authorized).map((tl) => tl.asset)
  );
  const unclaimableBalances = claimableBalances.filter(
    (b) => b.asset !== "native" && !authorizedTrustlineAssets.has(b.asset)
  );
  for (const b of unclaimableBalances) {
    const code = b.asset.split(":")[0];
    blockers.push({
      message:
        `This account is a claimant for ${b.amount} ${code} but has no authorized trustline ` +
        `for it. Establish a ${code} trustline and claim the balance manually before proceeding ` +
        `- these funds will be permanently inaccessible once the account is merged.`,
    });
  }

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

  if (
    fastPathEligible &&
    hasCleanup &&
    blockers.length === 0 &&
    claimableBalances.length === 0 &&
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

  // Claimable balances that can be automatically claimed: XLM (no trustline required)
  // or assets where an authorized trustline already exists. Batched like other operations.
  const claimable = claimableBalances.filter(
    (b) => b.asset === "native" || authorizedTrustlineAssets.has(b.asset)
  );
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

  // CONVERT_ASSETS: include trustlines with a current balance OR whose asset appears
  // in a claimable balance that will be claimed above - claiming runs first and increases
  // the live trustline balance, which the executor reads on-chain at step build time.
  const claimableNonXlmByAsset = new Map<string, number>();
  for (const b of claimable) {
    if (b.asset !== "native") {
      claimableNonXlmByAsset.set(
        b.asset,
        (claimableNonXlmByAsset.get(b.asset) ?? 0) + parseFloat(b.amount)
      );
    }
  }

  const trustlinesNeedingConversion = trustlines.filter(
    (tl) =>
      tl.authorized &&
      (parseFloat(tl.balance) > 0 || (claimableNonXlmByAsset.get(tl.asset) ?? 0) > 0)
  );

  for (const tl of trustlinesNeedingConversion) {
    steps.push(
      step(
        idx++,
        "CONVERT_ASSETS",
        `Convert ${tl.code} to XLM`,
        `Exchange ${tl.balance} ${tl.code} for XLM via the Stellar DEX.`,
        1,
        { affectedAsset: tl.asset }
      )
    );
  }

  if (trustlines.length > 0) {
    const batches = batchItems(trustlines, OP_BATCH_LIMIT);
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
