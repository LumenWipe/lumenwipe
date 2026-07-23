import { Account, Memo, TransactionBuilder } from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASES, type Network } from "@/config/networks";
import { BASE_FEE_STROOPS, OP_BATCH_LIMIT, TX_TIMEOUT_SECONDS } from "@/config/constants";
import { getRpcServer } from "@/lib/stellar/rpc";
import { fetchLiveTrustlineBalance, filterExistingClaimableBalances } from "@/lib/stellar/step-engine";
import { fetchConversionPath } from "@/lib/se-api/paths";
import { computeNeedsSignerNormalization } from "@/lib/stellar/tx-builder";
import { batchItems } from "@/lib/stellar/tx-builder/batching";
import {
  assembleFusedCloseOpsTagged,
  type AssetAction,
  type FusedCloseInput,
} from "@/lib/stellar/tx-builder/fused-close";
import { intentFromXdr } from "@/lib/stellar/intent/serialize";
import { AssetRouteLostError } from "@/lib/utils/errors";
import type { AccountState } from "@/types/account";
import type { AssetDisposition } from "@/types/plan";
import type { CloseTransaction } from "@/types/close-api";

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
// Direct destinations are produced as a single fused transaction, or a sequence-chained
// series when they exceed the per-transaction operation cap. Claimable-balance accounts
// are handled in two rounds: this call returns the claim transaction(s) with
// requiresAnotherCall=true, and once they confirm the next call sees a claimable-free
// account and returns the close itself. Exchange/mediator destinations are still rejected
// with a CloseBuildError; that path is a follow-up.
export async function buildCloseTransactions(
  accountState: AccountState,
  destinationAddress: string,
  dispositions: Record<string, AssetDisposition>,
  network: Network
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
    if (existing.length > 0) {
      const claimInput: FusedCloseInput = {
        needsSignerNormalization: false,
        signers: accountState.signers,
        dataEntries: [],
        openOffers: [],
        claimableBalances: existing,
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
    // All reported balances were already claimed; fall through and build the close now.
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

  const input: FusedCloseInput = {
    needsSignerNormalization: computeNeedsSignerNormalization(accountState),
    signers: accountState.signers,
    dataEntries: accountState.dataEntries,
    openOffers: accountState.openOffers,
    claimableBalances: [],
    assetActions,
    trustlines: accountState.trustlines,
    destinationAddress,
    memo: null,
    memoType: null,
    includeMerge: true,
  };

  return {
    transactions: packFusedCloseTransactions(sdkAccount, input, network, validUntilLedger),
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
  const summary = buildSummary(input);

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
      intent: { ...intentFromXdr(xdr, networkPassphrase), summary },
    };
  });
}
