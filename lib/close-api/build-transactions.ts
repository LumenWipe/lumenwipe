import { Account } from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASES, type Network } from "@/config/networks";
import { OP_BATCH_LIMIT, TX_TIMEOUT_SECONDS } from "@/config/constants";
import { getRpcServer } from "@/lib/stellar/rpc";
import { fetchLiveTrustlineBalance } from "@/lib/stellar/step-engine";
import { fetchConversionPath } from "@/lib/se-api/paths";
import { computeNeedsSignerNormalization } from "@/lib/stellar/tx-builder";
import {
  assembleFusedCloseOps,
  buildFusedCloseTx,
  type AssetAction,
  type FusedCloseInput,
} from "@/lib/stellar/tx-builder/fused-close";
import { intentFromXdr } from "@/lib/stellar/intent/serialize";
import { AssetRouteLostError } from "@/lib/utils/errors";
import type { AccountState } from "@/types/account";
import type { AssetDisposition, StepType } from "@/types/plan";
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

function collectCovers(input: FusedCloseInput): StepType[] {
  const covers: StepType[] = [];
  if (input.needsSignerNormalization) covers.push("NORMALIZE_SIGNERS");
  if (input.dataEntries.length > 0) covers.push("REMOVE_DATA_ENTRIES");
  if (input.openOffers.length > 0) covers.push("CANCEL_OFFERS");
  if (input.assetActions.length > 0) covers.push("CONVERT_ASSETS");
  if (input.trustlines.length > 0) covers.push("REMOVE_TRUSTLINES");
  if (input.includeMerge) covers.push("MERGE");
  return covers;
}

function buildSummary(input: FusedCloseInput): string {
  const parts: string[] = [];
  const converts = input.assetActions.filter((a) => a.action === "convert").length;
  const issuerReturns = input.assetActions.filter((a) => a.action === "issuer").length;
  if (converts > 0) parts.push(`convert ${converts} asset${converts === 1 ? "" : "s"} to XLM`);
  if (issuerReturns > 0)
    parts.push(`return ${issuerReturns} asset${issuerReturns === 1 ? "" : "s"} to the issuer`);
  if (input.trustlines.length > 0)
    parts.push(`remove ${input.trustlines.length} trustline${input.trustlines.length === 1 ? "" : "s"}`);
  if (input.includeMerge) parts.push("merge the account into the destination");
  const joined = parts.length > 0 ? parts.join(", ") : "close the account";
  return `${joined.charAt(0).toUpperCase()}${joined.slice(1)}.`;
}

// Builds the unsigned transaction(s) that close an account. Phase 1 supports direct
// destinations only and produces a single atomic fused transaction. Exchange/mediator
// destinations and claimable-balance accounts (which need the multi-step flow) and
// closes that exceed the per-transaction operation cap are rejected with a
// CloseBuildError; those paths are follow-ups. Re-reads live on-chain state.
export async function buildCloseTransactions(
  accountState: AccountState,
  destinationAddress: string,
  dispositions: Record<string, AssetDisposition>,
  network: Network
): Promise<CloseTransaction[]> {
  if (accountState.claimableBalances.length > 0) {
    throw new CloseBuildError(
      "claimable_balances_unsupported",
      "Accounts with claimable balances require the multi-step close, not yet exposed by this API."
    );
  }

  const server = getRpcServer(network);
  const liveAccount = await server.getAccount(accountState.address);
  const sdkAccount = new Account(accountState.address, liveAccount.sequenceNumber());

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

  const ops = assembleFusedCloseOps(accountState.address, input);
  if (ops.length > OP_BATCH_LIMIT) {
    throw new CloseBuildError(
      "too_many_operations",
      `This close needs ${ops.length} operations, over the ${OP_BATCH_LIMIT}-operation limit for one transaction; multi-transaction closes are not yet exposed by this API.`
    );
  }

  const xdr = buildFusedCloseTx(sdkAccount, input, network);
  const networkPassphrase = NETWORK_PASSPHRASES[network];
  const latest = await server.getLatestLedger();

  return [
    {
      id: "tx-1",
      order: 0,
      dependsOn: [],
      xdr,
      networkPassphrase,
      sourceSequence: liveAccount.sequenceNumber(),
      // Ledgers close roughly every 5s; surface an approximate ledger bound for the tx's time bound.
      validUntilLedger: latest.sequence + Math.ceil(TX_TIMEOUT_SECONDS / 5),
      covers: collectCovers(input),
      intent: { ...intentFromXdr(xdr, networkPassphrase), summary: buildSummary(input) },
    },
  ];
}
