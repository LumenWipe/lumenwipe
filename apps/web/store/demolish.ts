import { create } from "zustand";
import type { UnresolvedSubmission } from "@lumenwipe/sdk";
import { v4 as uuidv4 } from "uuid";
import { hasRouteLookupBlocker } from "@/lib/plan/resolvable-blockers";
import { forgetDecisions } from "@/lib/session/decision-snapshot";
import type { AccountState } from "@/types/account";
import type {
  PlannedStep,
  DemolishPhase,
  AssetDisposition,
  ClaimableBalanceSelection,
  StepStatus,
  StepType,
} from "@/types/plan";
import type { CompletedStepRecord } from "@/types/session";
import type { ExpectedReceive } from "@/lib/plan/expected-receive";
import type { PlanSignature } from "@/lib/plan/plan-freshness";

/** What a "convert" disposition is pinned to: the floor the plan quoted, which provider quoted
 *  it, and - only for an xBull-routed token - the live route `verify()` needs to hold its
 *  `strict_send` call to before signing (see `apps/web/lib/stellar/verify.ts`). */
export interface TokenConversionFloor {
  minAmountOut: string;
  /** The quoted XLM the plan showed beside the floor. */
  amountOut?: string;
  provider: "soroswap" | "xbull";
  resolvedPath?: string[];
}

/** The least XLM, in stroops, the plan showed a classic asset's conversion delivering; null for
 *  an asset only an exit pays in, which has no amount to quote until it lands. */
export interface ClassicConversionFloor {
  minAmountOut: string | null;
}

/** A saved close the user chose to resume, as this browser recorded it. */
export interface ResumedClose {
  source: string;
  startedAt: string;
  completedSteps: CompletedStepRecord[];
}

interface DemolishState {
  // Inputs
  sourceAddress: string | null;
  destinationAddress: string | null;
  memo: string | null;
  memoType: "text" | "id" | "hash" | null;
  /**
   * The destination the user explicitly confirmed they control, for a destination the
   * exchange registry does not recognize. Stored as the address rather than a boolean so
   * the confirmation cannot outlive the address it was given for: editing the destination
   * leaves this pointing at the old one, which no longer matches.
   */
  destinationAcknowledgedFor: string | null;
  /**
   * The account address the user explicitly confirmed has no DeFi positions, after checking
   * manually (e.g. on an explorer), for an account whose detection could not be confirmed.
   * Stored as the address for the same reason as `destinationAcknowledgedFor`: the confirmation
   * cannot outlive the account it was given for.
   */
  defiPositionsAcknowledgedFor: string | null;
  issuerSupplyAcknowledgedFor: string | null;
  /** Per Soroban token contract, the conversion floor (stroops) the user confirmed converting at
   *  although its quote was flagged. Keyed to the floor so a confirmation never covers a quote the
   *  user was not shown: once the plan quotes a new floor, the old entry no longer matches. Not
   *  kept across a reload, so a restored conversion is confirmed again. */
  conversionImpactAcknowledgedFor: Record<string, string>;
  /** Decision ids (`defi_leave:<account>:<contract>`) of the DeFi positions whose exit cannot be
   *  built that the user explicitly chose to leave behind. Each id names its account. */
  positionsLeftBehind: string[];

  // Preflight
  phase: DemolishPhase;
  accountState: AccountState | null;
  executionPlan: PlannedStep[];
  currentStepIndex: number;

  // Per-asset disposition: swap to XLM ("convert"), return to issuer ("issuer"), or send the
  // balance intact to an account of the user's choosing ("transfer")
  assetDispositions: Record<string, AssetDisposition>;

  // Where each "transfer" disposition sends its balance, keyed by the same asset string.
  // Kept here, in the user's own state, because verify() binds the transaction's payment
  // destination against it before signing - reading it back from the plan or the transaction
  // would make the check circular and prove nothing.
  transferDestinations: Record<string, string>;
  /** Per Soroban token contract, the least XLM (stroops) the plan quoted its conversion at: the
   *  floor the convert answer carries and the built swap is held to. */
  tokenConversionFloors: Record<string, TokenConversionFloor>;
  classicConversionFloors: Record<string, ClassicConversionFloor>;

  // Per-claimable-balance selection, keyed by balance id: claim it, add a trustline then
  // claim it, or forfeit it.
  claimableBalanceSelections: Record<string, ClaimableBalanceSelection>;

  // Mediator
  mediatorRequired: boolean;

  // Error
  /** A transaction handed to the network whose outcome is not settled yet. */
  unconfirmedSubmission: UnresolvedSubmission | null;
  lastError: string | null;
  lastErrorReference: string | null;
  /** Why the reviewed plan was discarded mid-close; shown on /analyze until a new plan is set. */
  planChangedNotice: string | null;
  /** The hash of the plan the user reviewed, sent with the build until a transaction confirms.
   *  Null once the account has changed on purpose, or when no reviewed plan is installed. */
  planHash: string | null;
  /** The installed plan's own transaction count, for /review. Display only: never sent to the
   *  API and never part of verify(). */
  estimatedTransactionCount: number | null;
  /** What the reviewed plan is expected to deliver, kept for the screens after /analyze. Display
   *  only: never sent to the API and never part of verify(). */
  expectedReceive: ExpectedReceive | null;
  /** When the installed plan was fetched, in epoch ms, for /review's "prepared" line. */
  planPreparedAt: number | null;
  /** The installed plan's material content, which /review compares a fresh plan against before
   *  signing. Display only: never sent to the API and never part of verify(). */
  planSignature: PlanSignature | null;
  /** Why the inputs were restored or reset after a reload, for the next page to show once. */
  reloadNotice: string | null;
  /** The execute page lost its plan to a reload and sent the user to the start page. */
  executeInterrupted: boolean;
  /** Set only by the resume banner, for what analyze and review say about the close being
   *  continued. It never sets a phase or a plan. */
  resumedClose: ResumedClose | null;

  // Session
  sessionId: string | null;
  /** A confirmed transaction of this close could not be recorded in its saved record. */
  progressNotSaved: boolean;
  /** A run of the close loop is signing or sending for this close. */
  signingRun: boolean;
  /** Counts resets: a run started before one belongs to a close this tab has left, even when the
   *  same account is loaded again. */
  closeEpoch: number;

  // Actions
  setAddresses: (
    source: string,
    dest: string,
    memo?: string,
    memoType?: "text" | "id" | "hash"
  ) => void;
  /** Records (or clears, with null) the destination the user confirmed they control. */
  acknowledgeDestination: (address: string | null) => void;
  /** Records (or clears, with null) the account the user confirmed has no DeFi positions. */
  acknowledgeDefiPositions: (address: string | null) => void;
  acknowledgeIssuerSupply: (address: string | null) => void;
  /** Records (or, with null, withdraws) the confirmation of a flagged token conversion. */
  acknowledgeConversionImpact: (contract: string, minAmountOut: string | null) => void;
  setPositionLeftBehind: (decisionId: string, leave: boolean) => void;
  /** Drops every leave choice the latest plan no longer offers, so none outlives its card. */
  prunePositionsLeftBehind: (offered: string[]) => void;
  setPhase: (phase: DemolishPhase) => void;
  setUnconfirmedSubmission: (submission: UnresolvedSubmission | null) => void;
  setProgressNotSaved: (notSaved: boolean) => void;
  setSigningRun: (running: boolean) => void;
  setAccountState: (state: AccountState) => void;
  /** Installs a plan, stamped as prepared now. A count or signature not given is cleared, so none
   *  outlives the plan it came with. */
  setPlan: (
    plan: PlannedStep[],
    planHash?: string,
    transactionCount?: number | null,
    signature?: PlanSignature
  ) => void;
  setExpectedReceive: (expected: ExpectedReceive | null) => void;
  /** Called once a transaction of the close confirms: the account has changed on purpose, so the
   *  reviewed plan's hash no longer describes it. */
  clearPlanHash: () => void;
  /** Drops a plan the account no longer matches, so neither /review nor /execute can act on it
   *  again: the only way on is a fresh plan through the review gate. */
  discardPlan: (notice: string) => void;
  setAssetDisposition: (asset: string, action: AssetDisposition) => void;
  /** Applies a freshly fetched plan's blockers to the stored answers: when the route lookup
   *  failed, every return-to-issuer choice is forgotten (the blocker names no asset) and convert
   *  and transfer answers are kept. */
  reconcileWithPlanBlockers: (blockers: Array<{ code?: string }>) => void;
  setTransferDestination: (asset: string, destination: string | null) => void;
  setTokenConversionFloors: (floors: Record<string, TokenConversionFloor>) => void;
  setClassicConversionFloors: (floors: Record<string, ClassicConversionFloor>) => void;
  setClaimableBalanceSelection: (balanceId: string, selection: ClaimableBalanceSelection) => void;
  /** Removes one balance's answer, so its card asks again. */
  clearClaimableBalanceSelection: (balanceId: string) => void;
  /** Drops the "convert" answer of each listed asset, stored or restored alike, so its card asks
   *  again: the latest plan gives no floor to hold that swap to. Other answers are kept. */
  pruneUnflooredConverts: (assets: readonly string[]) => void;
  /** Drops every claim answer the latest plan does not offer for its balance, stored or restored
   *  alike, so that balance is asked again. `offered` maps each balance the plan lists to its
   *  answers; a balance it does not list is left to the account-state prune. */
  pruneClaimSelectionsToOffered: (
    offered: Readonly<Record<string, readonly ClaimableBalanceSelection[]>>
  ) => void;
  setMediatorRequired: (required: boolean) => void;
  setCurrentStepIndex: (index: number) => void;
  markStepConfirmed: (index: number, txHash: string) => void;
  /**
   * Marks every not-yet-confirmed step whose type appears in `coveredTypes` as confirmed.
   * A single API-built transaction can cover several plan steps (a fused close), so one
   * confirmation lands multiple steps at once. `sponsoredFee` records that a dedicated sponsor
   * account, not the user's, paid this round's fee - the user's own account paid "0".
   */
  markCoveredConfirmed: (
    coveredTypes: StepType[],
    txHash: string,
    sponsoredFee?: boolean,
    /** Which steps of those types this transaction was for, by `affectedContract` (an exit) or
     *  `affectedAsset` (an asset or token). Omitted when it covers every step of those types. */
    coversTargets?: string[]
  ) => void;
  /**
   * Moves the not-yet-confirmed steps a transaction covers, matched as `markCoveredConfirmed`
   * matches them, to `status`. A confirmed step is never touched, and neither the phase nor the
   * error shown for the close changes: those stay with the close loop.
   */
  markCoveredStatus: (
    coveredTypes: readonly StepType[],
    coversTargets: readonly string[] | undefined,
    status: InFlightStepStatus,
    error?: string
  ) => void;
  /** Puts every step left signing or failed by an earlier attempt back to pending. A step left
   *  submitted keeps its status: that transaction may be on the ledger. */
  resetUnsettledSteps: () => void;
  setLastError: (error: string | null, reference?: string) => void;
  setReloadNotice: (notice: string | null) => void;
  setExecuteInterrupted: (interrupted: boolean) => void;
  setResumedClose: (resumed: ResumedClose | null) => void;
  initSession: () => void;
  restoreSession: (id: string) => void;
  reset: () => void;
}

/**
 * Drops disposition entries for assets the new account state no longer holds a
 * trustline for, while preserving decisions for assets that still exist. A fresh
 * scan of the same account therefore keeps the user's per-asset choices.
 */
/** Drops entries for assets the account no longer holds, so a re-analyze cannot leave a
 *  destination attached to a trustline that is gone. */
/** Assets a decision can legitimately be about: held in a trustline, or sitting in a claimable
 *  balance the user may choose to claim. Pruning to trustlines alone dropped the disposition of
 *  an asset arriving through a claim on every account re-read, and the auto-convert default
 *  silently refilled it - executing a swap the user had explicitly declined. */
function decidableAssets(accountState: AccountState): Set<string> {
  return new Set([
    ...accountState.trustlines.map((tl) => tl.asset),
    ...accountState.claimableBalances.filter((b) => b.asset !== "native").map((b) => b.asset),
    // Soroban token balances, keyed by contract like their decision ids.
    ...(accountState.sorobanTokens?.tokens ?? []).map((t) => t.contract),
  ]);
}

function pruneToPresentAssets<T>(
  destinations: Record<string, T>,
  accountState: AccountState
): Record<string, T> {
  const present = decidableAssets(accountState);
  const next: Record<string, T> = {};
  for (const [asset, destination] of Object.entries(destinations)) {
    if (present.has(asset)) next[asset] = destination;
  }
  return next;
}

function pruneDispositions(
  dispositions: Record<string, AssetDisposition>,
  accountState: AccountState
): Record<string, AssetDisposition> {
  const present = decidableAssets(accountState);
  const next: Record<string, AssetDisposition> = {};
  for (const [asset, action] of Object.entries(dispositions)) {
    if (present.has(asset)) next[asset] = action;
  }
  return next;
}

/**
 * Drops selection entries for claimable balances the new account state no longer reports
 * (already claimed by another claimant, or expired), while preserving selections for balances
 * that still exist - same rationale as `pruneDispositions`.
 */
function pruneClaimableSelections(
  selections: Record<string, ClaimableBalanceSelection>,
  accountState: AccountState
): Record<string, ClaimableBalanceSelection> {
  const present = new Set(accountState.claimableBalances.map((b) => b.id));
  const next: Record<string, ClaimableBalanceSelection> = {};
  for (const [balanceId, selection] of Object.entries(selections)) {
    if (present.has(balanceId)) next[balanceId] = selection;
  }
  return next;
}

/** A confirmed merge ends the close, so nothing of its inputs is kept to restore. */
function forgetIfClosed(plan: PlannedStep[]): void {
  const closed = plan.some(
    (s) => (s.type === "MERGE" || s.type === "CLOSE_ACCOUNT") && s.status === "confirmed"
  );
  if (closed) forgetDecisions();
}

const initialState = {
  sourceAddress: null,
  destinationAddress: null,
  memo: null,
  memoType: null,
  destinationAcknowledgedFor: null,
  defiPositionsAcknowledgedFor: null,
  issuerSupplyAcknowledgedFor: null,
  conversionImpactAcknowledgedFor: {} as Record<string, string>,
  positionsLeftBehind: [] as string[],
  phase: "IDLE" as DemolishPhase,
  accountState: null,
  executionPlan: [],
  currentStepIndex: 0,
  assetDispositions: {},
  transferDestinations: {},
  tokenConversionFloors: {},
  classicConversionFloors: {},
  claimableBalanceSelections: {},
  mediatorRequired: false,
  unconfirmedSubmission: null,
  lastError: null,
  lastErrorReference: null,
  planChangedNotice: null,
  planHash: null,
  estimatedTransactionCount: null,
  expectedReceive: null,
  planPreparedAt: null,
  planSignature: null,
  reloadNotice: null,
  executeInterrupted: false,
  resumedClose: null,
  sessionId: null,
  progressNotSaved: false,
  signingRun: false,
};

/** A step that is not settled yet, as the close loop moves a transaction through it. */
export type InFlightStepStatus = Extract<
  StepStatus,
  "pending" | "signing" | "submitted" | "failed"
>;

/**
 * Which plan steps a transaction is for. A close can hold several steps of one type - three DeFi
 * exits, two token transfers - and each is its own transaction. Marking by type alone confirmed
 * all of them off the first one and stamped them all with its hash, so the receipt reported one
 * exit where three had run. When the API names which step a transaction was for, by
 * `affectedContract` (an exit) or `affectedAsset` (an asset or token), only that step matches.
 */
export function coveredBy(
  coveredTypes: readonly StepType[],
  coversTargets: readonly string[] | undefined
): (step: PlannedStep) => boolean {
  const covered = new Set<StepType>(coveredTypes);
  const targets = coversTargets && coversTargets.length > 0 ? new Set(coversTargets) : null;
  return (step) => {
    if (!covered.has(step.type)) return false;
    if (!targets) return true;
    const identity = step.affectedContract ?? step.affectedAsset;
    return identity !== undefined && targets.has(identity);
  };
}

export const useDemolishStore = create<DemolishState>((set) => ({
  ...initialState,
  closeEpoch: 0,

  setAddresses: (source, dest, memo, memoType) =>
    set((state) => ({
      sourceAddress: source,
      destinationAddress: dest,
      memo: memo ?? null,
      memoType: memoType ?? null,
      // An unsettled hash belongs to the account it was sent for: carried over, its confirmation
      // would complete this other account's close. Its session stays saved under its own id.
      ...(state.sourceAddress !== source && {
        unconfirmedSubmission: null,
        sessionId: null,
        progressNotSaved: false,
        resumedClose: null,
      }),
    })),

  acknowledgeDestination: (address) => set({ destinationAcknowledgedFor: address }),

  acknowledgeDefiPositions: (address) => set({ defiPositionsAcknowledgedFor: address }),
  acknowledgeIssuerSupply: (address) => set({ issuerSupplyAcknowledgedFor: address }),
  acknowledgeConversionImpact: (contract, minAmountOut) =>
    set((s) => {
      const { [contract]: _dropped, ...rest } = s.conversionImpactAcknowledgedFor;
      return {
        conversionImpactAcknowledgedFor:
          minAmountOut === null ? rest : { ...rest, [contract]: minAmountOut },
      };
    }),
  setPositionLeftBehind: (decisionId, leave) =>
    set((s) => {
      const rest = s.positionsLeftBehind.filter((id) => id !== decisionId);
      return { positionsLeftBehind: leave ? [...rest, decisionId] : rest };
    }),
  prunePositionsLeftBehind: (offered) =>
    set((s) => {
      const kept = s.positionsLeftBehind.filter((id) => offered.includes(id));
      return kept.length === s.positionsLeftBehind.length ? {} : { positionsLeftBehind: kept };
    }),

  setPhase: (phase) => set({ phase }),
  setUnconfirmedSubmission: (unconfirmedSubmission) => set({ unconfirmedSubmission }),
  setProgressNotSaved: (progressNotSaved) => set({ progressNotSaved }),
  setSigningRun: (signingRun) => set({ signingRun }),

  setAccountState: (accountState) =>
    set((s) => ({
      accountState,
      // Keep per-asset decisions across a re-scan of the SAME assets (e.g. the
      // analyze-page refresh button, which re-runs the fetch and lands here):
      // wiping them dropped a user's "return to issuer" choice, after which the
      // fused close silently re-quoted the asset and failed with a lost route.
      // Prune to assets still present so a genuinely-gone trustline can't carry a
      // stale decision into the build.
      assetDispositions: pruneDispositions(s.assetDispositions, accountState),
      transferDestinations: pruneToPresentAssets(s.transferDestinations, accountState),
      tokenConversionFloors: pruneToPresentAssets(s.tokenConversionFloors, accountState),
      conversionImpactAcknowledgedFor: pruneToPresentAssets(
        s.conversionImpactAcknowledgedFor,
        accountState
      ),
      classicConversionFloors: pruneToPresentAssets(s.classicConversionFloors, accountState),
      claimableBalanceSelections: pruneClaimableSelections(
        s.claimableBalanceSelections,
        accountState
      ),
    })),

  // Reset the step pointer whenever a new plan is installed: a prior run may have
  // advanced currentStepIndex, and a new (often shorter) plan must start at step 0
  // so executionPlan[currentStepIndex] never points past the end.
  setPlan: (executionPlan, planHash, transactionCount, signature) =>
    set({
      executionPlan,
      currentStepIndex: 0,
      planChangedNotice: null,
      planHash: planHash ?? null,
      estimatedTransactionCount: transactionCount ?? null,
      planPreparedAt: Date.now(),
      planSignature: signature ?? null,
    }),

  setExpectedReceive: (expectedReceive) => set({ expectedReceive }),

  clearPlanHash: () => set({ planHash: null }),

  discardPlan: (notice) =>
    set({
      executionPlan: [],
      currentStepIndex: 0,
      phase: "IDLE",
      lastError: null,
      lastErrorReference: null,
      planChangedNotice: notice,
      planHash: null,
      estimatedTransactionCount: null,
      expectedReceive: null,
      planPreparedAt: null,
      planSignature: null,
    }),

  setAssetDisposition: (asset, action) =>
    set((s) => {
      // Switching away from transfer drops the destination with it: a stale one would still be
      // handed to verify(), which would then vouch for a payment the user is no longer asking
      // for.
      if (action === "transfer") {
        return { assetDispositions: { ...s.assetDispositions, [asset]: action } };
      }
      const { [asset]: _dropped, ...rest } = s.transferDestinations;
      return {
        assetDispositions: { ...s.assetDispositions, [asset]: action },
        transferDestinations: rest,
      };
    }),

  reconcileWithPlanBlockers: (blockers) =>
    set((s) =>
      hasRouteLookupBlocker(blockers)
        ? {
            assetDispositions: Object.fromEntries(
              Object.entries(s.assetDispositions).filter(([, action]) => action !== "issuer")
            ),
          }
        : {}
    ),

  setTokenConversionFloors: (floors) => set({ tokenConversionFloors: floors }),
  setClassicConversionFloors: (floors) => set({ classicConversionFloors: floors }),

  setTransferDestination: (asset, destination) =>
    set((s) => {
      if (destination === null) {
        const { [asset]: _cleared, ...rest } = s.transferDestinations;
        return { transferDestinations: rest };
      }
      return { transferDestinations: { ...s.transferDestinations, [asset]: destination } };
    }),

  clearClaimableBalanceSelection: (balanceId) =>
    set((s) => {
      if (!(balanceId in s.claimableBalanceSelections)) return {};
      const { [balanceId]: _cleared, ...rest } = s.claimableBalanceSelections;
      return { claimableBalanceSelections: rest };
    }),
  pruneClaimSelectionsToOffered: (offered) =>
    set((s) => {
      const kept: Record<string, ClaimableBalanceSelection> = {};
      let dropped = false;
      for (const [balanceId, selection] of Object.entries(s.claimableBalanceSelections)) {
        const answers = offered[balanceId];
        if (answers !== undefined && !answers.includes(selection)) dropped = true;
        else kept[balanceId] = selection;
      }
      return dropped ? { claimableBalanceSelections: kept } : {};
    }),
  pruneUnflooredConverts: (assets) =>
    set((s) => {
      const drop = assets.filter((asset) => s.assetDispositions[asset] === "convert");
      if (drop.length === 0) return {};
      const kept = { ...s.assetDispositions };
      for (const asset of drop) delete kept[asset];
      return { assetDispositions: kept };
    }),
  setClaimableBalanceSelection: (balanceId, selection) =>
    set((s) => ({
      claimableBalanceSelections: { ...s.claimableBalanceSelections, [balanceId]: selection },
    })),

  setMediatorRequired: (required) => set({ mediatorRequired: required }),

  setCurrentStepIndex: (currentStepIndex) => set({ currentStepIndex }),

  markStepConfirmed: (index, txHash) =>
    set((state) => {
      const executionPlan = state.executionPlan.map((s) =>
        s.index === index ? { ...s, status: "confirmed" as const, txHash } : s
      );
      forgetIfClosed(executionPlan);
      return { executionPlan, phase: "STEP_CONFIRMED" };
    }),

  markCoveredConfirmed: (coveredTypes, txHash, sponsoredFee, coversTargets) =>
    set((state) => {
      const isFor = coveredBy(coveredTypes, coversTargets);
      const executionPlan = state.executionPlan.map((s) =>
        isFor(s) && s.status !== "confirmed"
          ? {
              ...s,
              status: "confirmed" as const,
              txHash,
              actualFeeLumens: sponsoredFee ? "0" : s.estimatedFeeLumens,
            }
          : s
      );
      forgetIfClosed(executionPlan);
      return { executionPlan, phase: "STEP_CONFIRMED" };
    }),

  markCoveredStatus: (coveredTypes, coversTargets, status, error) =>
    set((state) => {
      const isFor = coveredBy(coveredTypes, coversTargets);
      return {
        executionPlan: state.executionPlan.map((s) =>
          isFor(s) && s.status !== "confirmed" && s.status !== "skipped"
            ? { ...s, status, error: status === "failed" ? (error ?? null) : null }
            : s
        ),
      };
    }),

  resetUnsettledSteps: () =>
    set((state) => ({
      executionPlan: state.executionPlan.map((s) =>
        s.status === "signing" || s.status === "failed"
          ? { ...s, status: "pending" as const, error: null }
          : s
      ),
    })),

  setLastError: (lastError, reference) => set({ lastError, lastErrorReference: reference ?? null }),
  setReloadNotice: (reloadNotice) => set({ reloadNotice }),
  setExecuteInterrupted: (executeInterrupted) => set({ executeInterrupted }),
  setResumedClose: (resumedClose) => set({ resumedClose }),

  initSession: () => set({ sessionId: uuidv4() }),

  // Reuses an existing session ID instead of generating a new one. Used by the
  // resume flow so that subsequent saveSession calls overwrite the same IndexedDB
  // record rather than creating an orphan that remains "in_progress" forever.
  restoreSession: (id) => set({ sessionId: id }),

  // A store holding no account is one a reload just emptied: its saved inputs are what a restore
  // is about to read, so only leaving a close the store holds forgets them.
  reset: () =>
    set((s) => {
      if (s.sourceAddress !== null || s.accountState !== null) forgetDecisions();
      return { ...initialState, closeEpoch: s.closeEpoch + 1 };
    }),
}));
