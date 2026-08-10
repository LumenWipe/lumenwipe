import { Account, Memo, TransactionBuilder } from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASES, getMediatorPublicKey, type Network } from "@/config/networks";
import { BASE_FEE_STROOPS, OP_BATCH_LIMIT, TX_TIMEOUT_SECONDS } from "@/config/constants";
import { getRpcServer } from "@/lib/stellar/rpc";
import { fetchLiveTrustlineBalance, filterExistingClaimableBalances } from "@/lib/stellar/step-engine";
import { fetchConversionPath } from "@/lib/se-api/paths";
import { lookupExchange, requiresMediatorForAddress } from "@/lib/exchange-registry";
import { computeNeedsSignerNormalization } from "@/lib/stellar/tx-builder";
import { assessSponsorshipAffordability } from "@/lib/stellar/sponsorship-affordability";
import { batchItems } from "@/lib/stellar/tx-builder/batching";
import {
  assembleFusedCloseOpsTagged,
  type AssetAction,
  type FusedCloseInput,
} from "@/lib/stellar/tx-builder/fused-close";
import { buildMediatorMergePaymentTx } from "@/lib/stellar/tx-builder/merge";
import { intentFromXdr } from "@/lib/stellar/intent/serialize";
import { AssetRouteLostError } from "@/lib/utils/errors";
import type {
  AccountState,
  AssetDisposition,
  ClaimableBalance,
  ClaimableBalanceSelection,
  CloseTransaction,
} from "@lumenwipe/types";

// Raised when a close cannot be expressed as the phase-1 single fused transaction.
// The route handler maps `code` to an error response.
export class CloseBuildError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 422
  ) {
    super(message);
    this.name = "CloseBuildError";
  }
}

function buildSummary(input: FusedCloseInput): string {
  const parts: string[] = [];
  if (input.revokeSponsorshipEntries.length > 0)
    parts.push(
      `revoke ${input.revokeSponsorshipEntries.length} sponsorship${input.revokeSponsorshipEntries.length === 1 ? "" : "s"}`
    );
  if (input.claimableBalances.length > 0)
    parts.push(
      `claim ${input.claimableBalances.length} balance${input.claimableBalances.length === 1 ? "" : "s"}`
    );
  const converts = input.assetActions.filter((a) => a.action === "convert").length;
  const issuerReturns = input.assetActions.filter((a) => a.action === "issuer").length;
  if (converts > 0) parts.push(`convert ${converts} asset${converts === 1 ? "" : "s"} to XLM`);
  if (issuerReturns > 0)
    parts.push(`return ${issuerReturns} asset${issuerReturns === 1 ? "" : "s"} to the issuer`);
  if (input.trustlines.length > 0)
    parts.push(
      `remove ${input.trustlines.length} trustline${input.trustlines.length === 1 ? "" : "s"}`
    );
  if (input.includeMerge) parts.push("merge the account into the destination");
  const joined = parts.length > 0 ? parts.join(", ") : "close the account";
  return `${joined.charAt(0).toUpperCase()}${joined.slice(1)}.`;
}

/** The next batch of unsigned transactions plus whether the client must call again. */
export interface CloseBuildResult {
  transactions: CloseTransaction[];
  requiresAnotherCall: boolean;
  remainingSteps: number;
}

// Builds the next unsigned transaction(s) for a close, re-reading live on-chain state.
// The close is produced as the minimal set of transactions and driven over as many rounds
// as needed (the client submits, waits for confirmation, then calls again):
//   - direct destination: a single fused transaction, or a sequence-chained series when it
//     exceeds the per-transaction operation cap;
//   - claimable balances: a claim round first, then the close once they confirm;
//   - exchange (mediator) destination: a cleanup round first (subentries + conversion, no
//     merge), then the mediator merge + forward payment built against the post-cleanup
//     balance.
// `requiresAnotherCall` is true whenever more transactions follow the returned batch.
export async function buildCloseTransactions(
  accountState: AccountState,
  destinationAddress: string,
  dispositions: Record<string, AssetDisposition>,
  network: Network,
  memo: string | null = null,
  claimableBalanceSelections: Record<string, ClaimableBalanceSelection> = {}
): Promise<CloseBuildResult> {
  const server = getRpcServer(network);
  const liveAccount = await server.getAccount(accountState.address);
  const sdkAccount = new Account(accountState.address, liveAccount.sequenceNumber());
  const latest = await server.getLatestLedger();
  // Ledgers close roughly every 5s; surface an approximate ledger bound for the tx time bound.
  const validUntilLedger = latest.sequence + Math.ceil(TX_TIMEOUT_SECONDS / 5);

  // Round 1 for claimable-balance accounts: claim first (re-reading which are still
  // on-chain), then the client calls again to build the now claimable-free close. The
  // claim must precede the close because a claim raises the balance the close disposes of.
  if (accountState.claimableBalances.length > 0) {
    const existing = await filterExistingClaimableBalances(accountState.claimableBalances, server);
    const authorizedTrustlineAssets = new Set(
      accountState.trustlines.filter((tl) => tl.authorized).map((tl) => tl.asset)
    );
    const isCurrentlyClaimable = (b: ClaimableBalance): boolean =>
      b.asset === "native" || authorizedTrustlineAssets.has(b.asset);
    // Currently claimable and not opted out (the opt-out default), plus the ones remediated
    // with a new trustline. Forfeited or unresolved balances are excluded entirely - never
    // claimed, never blocking the close.
    const toAddTrustlineThenClaim = existing.filter(
      (b) =>
        !isCurrentlyClaimable(b) &&
        claimableBalanceSelections[b.id] === "add_trustline_then_claim"
    );
    const toClaim = existing.filter(
      (b) => isCurrentlyClaimable(b) && claimableBalanceSelections[b.id] !== "forfeit"
    );
    const claimRoundBalances = toClaim.concat(toAddTrustlineThenClaim);
    if (claimRoundBalances.length > 0) {
      const claimInput: FusedCloseInput = {
        needsSignerNormalization: false,
        signers: accountState.signers,
        // Sponsorship revocation never belongs in the claim round: it has no ordering
        // dependency on claiming, and Task 5's plan-time gate already excludes any
        // account with sponsoredEntries from the fused/fast path, so the claim round
        // (which only ever runs ahead of that fused close) never needs to carry it.
        revokeSponsorshipEntries: [],
        dataEntries: [],
        openOffers: [],
        claimableBalances: claimRoundBalances,
        trustlinesToAddForClaim: toAddTrustlineThenClaim,
        assetActions: [],
        trustlines: [],
        destinationAddress,
        memo: null,
        memoType: null,
        includeMerge: false,
      };
      return {
        transactions: packFusedCloseTransactions(sdkAccount, claimInput, network, validUntilLedger),
        requiresAnotherCall: true,
        remainingSteps: 1,
      };
    }
    // Every reported balance was already claimed, or every remaining one is
    // forfeited/unresolved; fall through and build the close now.
  }

  // Re-read every trustline's live balance: a line empty at scan but funded since must
  // still be disposed of, or the atomic close fails at its trustline-removal op.
  const withActions = await Promise.all(
    accountState.trustlines.map(async (tl): Promise<AssetAction | null> => {
      const liveBalance = await fetchLiveTrustlineBalance(tl, accountState.address, server);
      if (parseFloat(liveBalance) <= 0) return null;
      const effectiveTl = { ...tl, balance: liveBalance };
      const disposition = dispositions[tl.asset] ?? "convert";
      if (disposition === "issuer") return { trustline: effectiveTl, action: "issuer" };
      const path = await fetchConversionPath(effectiveTl.asset, effectiveTl.balance, network);
      if (!path) throw new AssetRouteLostError(tl.asset, tl.code);
      return { trustline: effectiveTl, action: "convert", path };
    })
  );
  const assetActions = withActions.filter((a): a is AssetAction => a !== null);

  // The exchange registry dictates the memo type; the client only supplies the value.
  const needsMediator = requiresMediatorForAddress(destinationAddress);
  const exchange = lookupExchange(destinationAddress);
  const memoType = exchange?.memoType ?? (memo ? "text" : null);

  // Live re-read immediately before build: /close/plan may have assessed affordability
  // minutes ago, and the sponsored owner's on-chain reserve state can have changed since -
  // this is a deliberate, separate call, not a reuse of the plan-time result.
  const nonClaimableSponsoredEntries = accountState.sponsoredEntries.filter(
    (e) => e.kind !== "claimable_balance"
  );
  const sponsorshipAffordability = accountState.sponsorshipEnumerationIncomplete
    ? { revocable: [], unaffordableOwners: new Map() }
    : await assessSponsorshipAffordability(accountState.address, nonClaimableSponsoredEntries, network);

  const input: FusedCloseInput = {
    needsSignerNormalization: computeNeedsSignerNormalization(accountState),
    signers: accountState.signers,
    revokeSponsorshipEntries: sponsorshipAffordability.revocable,
    dataEntries: accountState.dataEntries,
    openOffers: accountState.openOffers,
    claimableBalances: [],
    trustlinesToAddForClaim: [],
    assetActions,
    trustlines: accountState.trustlines,
    destinationAddress,
    memo,
    memoType,
    // Direct destinations merge inside the fused tx; exchange destinations merge through
    // the mediator in a separate transaction built once cleanup confirms.
    includeMerge: !needsMediator,
  };

  const closeTxs = packFusedCloseTransactions(sdkAccount, input, network, validUntilLedger);

  if (!needsMediator) {
    return { transactions: closeTxs, requiresAnotherCall: false, remainingSteps: 0 };
  }

  // Exchange destination. Clean up first (remove subentries, convert assets); once those
  // confirm, the account holds only XLM and the next call builds the mediator merge.
  if (closeTxs.length > 0) {
    return { transactions: closeTxs, requiresAnotherCall: true, remainingSteps: 1 };
  }

  const mediatorPublicKey = getMediatorPublicKey(network);
  if (!mediatorPublicKey) {
    throw new CloseBuildError(
      "mediator_not_configured",
      "The exchange (mediator) flow is not configured on this server.",
      503
    );
  }

  const networkPassphrase = NETWORK_PASSPHRASES[network];
  const sourceSequence = sdkAccount.sequenceNumber();
  const xdr = buildMediatorMergePaymentTx(
    sdkAccount,
    mediatorPublicKey,
    destinationAddress,
    accountState.nativeBalanceLumens,
    memo,
    network,
    memoType
  );

  return {
    transactions: [
      {
        id: "tx-1",
        order: 0,
        dependsOn: [],
        xdr,
        networkPassphrase,
        sourceSequence,
        validUntilLedger,
        covers: ["MERGE"],
        intent: {
          ...intentFromXdr(xdr, networkPassphrase),
          summary: "Merge the account through the mediator and forward the balance to the destination.",
        },
      },
    ],
    requiresAnotherCall: false,
    remainingSteps: 0,
  };
}

/**
 * Packs an assembled fused close into the minimal set of unsigned transactions:
 * a single fused tx when it fits under the per-transaction operation cap, or a
 * sequence-chained series of at most OP_BATCH_LIMIT operations each when it does
 * not. The account merge always lands in the last transaction, so every subentry
 * is gone before it runs, and the memo (if any) rides that same last transaction.
 * Pure: reusing one Account across builds chains the sequence numbers with no
 * network access. The client submits the transactions in `order`.
 */
export function packFusedCloseTransactions(
  sdkAccount: Account,
  input: FusedCloseInput,
  network: Network,
  validUntilLedger: number
): CloseTransaction[] {
  const tagged = assembleFusedCloseOpsTagged(sdkAccount.accountId(), input);
  const chunks = batchItems(tagged, OP_BATCH_LIMIT);
  const networkPassphrase = NETWORK_PASSPHRASES[network];
  const fullSummary = buildSummary(input);

  return chunks.map((chunk, i): CloseTransaction => {
    const isLast = i === chunks.length - 1;
    const sourceSequence = sdkAccount.sequenceNumber();

    // The SDK multiplies `fee` by the operation count, so the per-operation base
    // fee yields BASE_FEE_STROOPS * opCount on-chain.
    const builder = new TransactionBuilder(sdkAccount, {
      fee: String(BASE_FEE_STROOPS),
      networkPassphrase,
    }).setTimeout(TX_TIMEOUT_SECONDS);
    // The memo only belongs on the merge-carrying (last) transaction.
    if (isLast && input.includeMerge && input.memo) {
      builder.addMemo(input.memoType === "id" ? Memo.id(input.memo) : Memo.text(input.memo));
    }
    for (const t of chunk) builder.addOperation(t.op);
    const xdr = builder.build().toEnvelope().toXDR("base64");

    return {
      id: `tx-${i + 1}`,
      order: i,
      dependsOn: i === 0 ? [] : [`tx-${i}`],
      xdr,
      networkPassphrase,
      sourceSequence,
      validUntilLedger,
      covers: [...new Set(chunk.map((t) => t.step))],
      intent: {
        ...intentFromXdr(xdr, networkPassphrase),
        // A split close describes each transaction by position; the whole-close summary
        // would wrongly claim actions (e.g. the merge) that this transaction does not do.
        summary:
          chunks.length === 1
            ? fullSummary
            : `Transaction ${i + 1} of ${chunks.length} of the account close.`,
      },
    };
  });
}
