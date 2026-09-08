import { Account, Memo, TransactionBuilder } from "@stellar/stellar-sdk";
import {
  buildExitRound,
  ExitRoundBlockedError,
  type ExitRoundDeps,
} from "@/lib/defi-exits/exit-round";
import { NETWORK_PASSPHRASES, getMediatorPublicKey, type Network } from "@/config/networks";
import {
  ACCOUNT_BASE_RESERVE_XLM,
  BASE_FEE_STROOPS,
  BASE_RESERVE_XLM,
  OP_BATCH_LIMIT,
  TX_TIMEOUT_SECONDS,
} from "@/config/constants";
import { xlmToStroops } from "@/lib/utils/amounts";
import { getRpcServer } from "@/lib/stellar/rpc";
import { assessDefiPositionsGate } from "@/lib/defi-positions/positions-gate";
import {
  fetchLiveTrustlineBalance,
  filterExistingClaimableBalances,
} from "@/lib/stellar/step-engine";
import { fetchConversionPath } from "@/lib/stellar/path-finding";
import { lookupExchange, requiresMediatorForAddress } from "@/lib/exchange-registry";
import {
  computeNeedsSignerNormalization,
  assessSignerNormalizationSafety,
  assessDeauthorizedTrustlineBlockers,
} from "@/lib/stellar/tx-builder";
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
  TransferDestinations,
} from "@lumenwipe/types";
import { MissingTransferDestinationError, isTokenContract } from "@/lib/close-api/decisions";
import {
  TokenTransferBlockedError,
  buildTokenTransferRound,
  type TokenTransferRoundDeps,
} from "@/lib/close-api/token-transfer-round";
import {
  buildTokenConversionRound,
  defaultTokenConversionRoundDeps,
  type TokenConversionRoundDeps,
} from "@/lib/close-api/token-conversion-round";
import { isConversionEnabled } from "@/lib/soroswap/conversion-quotes";

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
  // Named, not just counted. This summary is what the caller is shown before an irreversible
  // close, and a transfer is the one operation that moves value to an account of their choosing
  // - "transfer 1 asset to another account" gives them nothing to check the address against.
  const transferred = input.assetActions.filter((a) => a.action === "transfer");
  const transfers = transferred.length;
  if (converts > 0) parts.push(`convert ${converts} asset${converts === 1 ? "" : "s"} to XLM`);
  if (issuerReturns > 0)
    parts.push(`return ${issuerReturns} asset${issuerReturns === 1 ? "" : "s"} to the issuer`);
  if (transfers > 0) {
    const named = transferred
      .map((a) => `${a.trustline.code} to ${a.action === "transfer" ? a.destination : ""}`)
      .join(", ");
    parts.push(`transfer ${named}`);
  }
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
  claimableBalanceSelections: Record<string, ClaimableBalanceSelection> = {},
  transferDestinations: TransferDestinations = {},
  exitDeps: Partial<ExitRoundDeps> = {},
  tokenDeps: Partial<TokenTransferRoundDeps> = {},
  conversion: {
    /** Per token contract, the least XLM (stroops) the caller agreed to; from the answers. */
    floors?: Record<string, string>;
    deps?: Partial<TokenConversionRoundDeps>;
    /** Overrides the environment flag; tests only. */
    enabled?: boolean;
  } = {}
): Promise<CloseBuildResult> {
  // Reject the same two hostile states buildPlan() blocks (issue #167), before any read or
  // build work: /close/transactions is an API-key product surface with an SDK, and
  // @lumenwipe/sdk's own runClose calls this endpoint directly without ever requesting a plan -
  // so buildPlan()'s blockers cannot be assumed to have already run. A weight-0 master key or an
  // unsatisfiable signer threshold, left unchecked here, would let this endpoint build a
  // normalization transaction that strips the account's only usable signers - a permanent fund
  // lock, not just a failed submission - and a deauthorized trustline with a balance would build
  // a ChangeTrust doomed to fail at the ledger (CHANGE_TRUST_INVALID_LIMIT). Checked first, ahead
  // of every other read in this function (including the claimable-balance round), both because
  // neither depends on any I/O and because a hostile account state should never even reach a
  // conversion-route lookup for a trustline it's about to be refused over.
  if (computeNeedsSignerNormalization(accountState)) {
    const signerBlockers = assessSignerNormalizationSafety(accountState);
    if (signerBlockers.length > 0) {
      throw new CloseBuildError("signer_normalization_unsafe", signerBlockers[0]!.message, 422);
    }
  }
  const trustlineBlockers = assessDeauthorizedTrustlineBlockers(accountState.trustlines);
  if (trustlineBlockers.length > 0) {
    throw new CloseBuildError(
      "trustline_deauthorized_with_balance",
      trustlineBlockers[0]!.message,
      422
    );
  }
  // The plan's DeFi gate, re-applied for the same reason: an SDK caller never asked for a plan,
  // and a web session's plan may be minutes old. Positions that could not be confirmed (an
  // indexer outage, a stale snapshot, a contract that could not be read) must not reach a merge
  // that would strand them - the exit round below can only leave what detection actually saw.
  const defiBlockers = assessDefiPositionsGate(accountState.defiPositions);
  if (defiBlockers.length > 0) {
    const first = defiBlockers[0]!;
    throw new CloseBuildError(first.code ?? "defi_positions_blocked", first.message, 422);
  }

  const server = getRpcServer(network);
  const liveAccount = await server.getAccount(accountState.address);
  const sdkAccount = new Account(accountState.address, liveAccount.sequenceNumber());
  const latest = await server.getLatestLedger();
  // Ledgers close roughly every 5s; surface an approximate ledger bound for the tx time bound.
  const validUntilLedger = latest.sequence + Math.ceil(TX_TIMEOUT_SECONDS / 5);

  // Round 0 for accounts with DeFi positions: leave every protocol first, one Soroban transaction
  // per step (a repay, then a withdraw...), each simulated against the current ledger. Proceeds
  // land in trustlines the later rounds dispose of and remove. The client submits, waits, and
  // calls again; positions are re-detected from live state each time.
  try {
    const exit = await buildExitRound(
      accountState,
      network,
      sdkAccount.sequenceNumber(),
      validUntilLedger,
      { rpc: server, ...exitDeps }
    );
    if (exit) {
      return {
        transactions: [exit.transaction],
        requiresAnotherCall: true,
        remainingSteps: exit.remainingSteps + 1,
      };
    }
  } catch (e) {
    if (e instanceof ExitRoundBlockedError) throw new CloseBuildError(e.code, e.message, 422);
    throw e;
  }

  // Soroban token balances the user chose to transfer as-is: one transaction per token, built
  // and simulated here, after the exits (which can pay a token out) and before anything classic.
  // Tokens the user chose to leave need nothing: a contract balance does not stop the merge.
  try {
    // Answers the close can never honour are refused here, before the first token moves: a
    // transfer signed in this round is irreversible, and finding the refusal two rounds later
    // would leave the account half closed.
    for (const tl of accountState.trustlines) {
      if (dispositions[tl.asset] === "leave") {
        throw new TokenTransferBlockedError(
          "trustline_cannot_be_left",
          `${tl.code} is a classic asset held in a trustline; a trustline with a balance cannot be ` +
            "left behind, or the account cannot be merged. Convert it, send it to another account, " +
            "or return it to its issuer."
        );
      }
    }
    const conversionOn = conversion.enabled ?? isConversionEnabled();
    for (const [asset, disposition] of Object.entries(dispositions)) {
      if (disposition === "convert" && isTokenContract(asset) && !conversionOn) {
        throw new TokenTransferBlockedError(
          "soroban_token_conversion_unavailable",
          `Converting the ${asset.slice(0, 4)}…${asset.slice(-4)} token to XLM is not available ` +
            "here. Send it to another account, or leave it on record."
        );
      }
    }
    const tokenRound = await buildTokenTransferRound(
      accountState,
      dispositions,
      transferDestinations,
      network,
      sdkAccount.sequenceNumber(),
      validUntilLedger,
      { rpc: server, ...tokenDeps }
    );
    if (tokenRound) {
      return {
        transactions: [tokenRound.transaction],
        requiresAnotherCall: true,
        remainingSteps: tokenRound.remainingSteps + 1,
      };
    }
    // Conversions after transfers: each is quoted against the live balance, built through the
    // Soroswap API, and refused unless its shape is exactly a swap of this token into this account.
    if (conversionOn) {
      const conversionRound = await buildTokenConversionRound(
        accountState,
        dispositions,
        conversion.floors ?? {},
        network,
        sdkAccount.sequenceNumber(),
        validUntilLedger,
        { ...defaultTokenConversionRoundDeps(server), ...conversion.deps }
      );
      if (conversionRound) {
        return {
          transactions: [conversionRound.transaction],
          requiresAnotherCall: true,
          remainingSteps: conversionRound.remainingSteps + 1,
        };
      }
    }
  } catch (e) {
    // 409 for a drifted quote, like the classic route: the plan is stale, not the request wrong.
    if (e instanceof TokenTransferBlockedError) {
      throw new CloseBuildError(e.code, e.message, e.code === "quote_drifted" ? 409 : 422);
    }
    throw e;
  }

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
        !isCurrentlyClaimable(b) && claimableBalanceSelections[b.id] === "add_trustline_then_claim"
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
        transactions: packFusedCloseTransactions(
          sdkAccount,
          claimInput,
          network,
          validUntilLedger,
          accountState
        ),
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
      // Only a Soroban token can be left behind; a trustline holding a balance stops the merge.
      // An answer that says otherwise is refused by name rather than quietly converted.
      if (disposition === "leave") {
        throw new CloseBuildError(
          "trustline_cannot_be_left",
          `${tl.code} is a classic asset held in a trustline; a trustline with a balance cannot be ` +
            "left behind, or the account cannot be merged. Convert it, send it to another account, " +
            "or return it to its issuer.",
          422
        );
      }
      if (disposition === "issuer") return { trustline: effectiveTl, action: "issuer" };
      if (disposition === "transfer") {
        const destination = transferDestinations[tl.asset];
        // Refusing beats falling through to the conversion below, which would swap away the
        // exact balance the caller asked to keep - silently, and irreversibly.
        if (!destination) throw new MissingTransferDestinationError(tl.asset);
        return { trustline: effectiveTl, action: "transfer", destination };
      }

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
    : await assessSponsorshipAffordability(
        accountState.address,
        nonClaimableSponsoredEntries,
        network
      );

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

  const closeTxs = packFusedCloseTransactions(
    sdkAccount,
    input,
    network,
    validUntilLedger,
    accountState
  );

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
          summary:
            "Merge the account through the mediator and forward the balance to the destination.",
        },
      },
    ],
    requiresAnotherCall: false,
    remainingSteps: 0,
  };
}

/**
 * What stays in the account no matter what: the base reserve, plus one more reserve for each
 * subentry and each entry the account sponsors for someone else - the same figure the network
 * itself enforces before it will let the account's balance drop any further. Everything above
 * this line is what a classic transaction's own fee may draw on (architecture.md §8.1's
 * `txINSUFFICIENT_BALANCE`: the fee would take the account below this).
 */
function reserveStroops(numSubEntries: number, numSponsoring: number): bigint {
  return (
    BigInt(xlmToStroops(ACCOUNT_BASE_RESERVE_XLM.toFixed(7))) +
    BigInt(xlmToStroops(BASE_RESERVE_XLM.toFixed(7))) * BigInt(numSubEntries + numSponsoring)
  );
}

/**
 * Whether the account can pay a fee of `feeStroops` for a transaction of its own, without going
 * below its reserve, judged from `accountState.nativeBalanceLumens` as given (no running
 * decrement). Exported for direct unit coverage of the reserve arithmetic and for a single
 * transaction's affordability; `packFusedCloseTransactions` below inlines this same comparison
 * against a running per-chunk balance instead of calling this, since a multi-chunk round needs
 * each later chunk judged against what's left after earlier chunks' fees, not the round's
 * original balance.
 */
export function accountCanAffordFee(
  accountState: Pick<AccountState, "nativeBalanceLumens" | "numSubEntries" | "numSponsoring">,
  feeStroops: bigint
): boolean {
  const balance = BigInt(xlmToStroops(accountState.nativeBalanceLumens));
  const reserve = reserveStroops(accountState.numSubEntries, accountState.numSponsoring);
  return balance - reserve >= feeStroops;
}

/**
 * Packs an assembled fused close into the minimal set of unsigned transactions:
 * a single fused tx when it fits under the per-transaction operation cap, or a
 * sequence-chained series of at most OP_BATCH_LIMIT operations each when it does
 * not. The account merge always lands in the last transaction, so every subentry
 * is gone before it runs, and the memo (if any) rides that same last transaction.
 * Pure: reusing one Account across builds chains the sequence numbers with no
 * network access. The client submits the transactions in `order`.
 *
 * `feeAffordability` is the account state to judge each chunk's fee against - the round's own
 * snapshot, read once and held fixed for every chunk built here (architecture.md §8.1). A chunk
 * whose fee the account cannot pay without dropping below its reserve is built with its own fee
 * at zero and flagged `needsSponsoredFee: true`, so the client routes it through the fee-bump
 * sponsor (`/fee-bump/sponsor`) before submitting instead of paying the network directly. The
 * account's *reserve* is not re-evaluated chunk to chunk, even though an earlier chunk would free
 * reserve on-chain by removing subentries: this round's transactions are all built from one
 * static snapshot with no network access in between, and a later round - which does re-read
 * state - is where a chunk that turns out to no longer need sponsoring gets built without it. Its
 * *balance*, however, IS tracked chunk to chunk within this one call: an earlier chunk built
 * unsponsored spends its own fee out of that same balance once it lands on-chain, so a later
 * chunk in the same round must be judged against what's left after that spend, not the round's
 * original balance - otherwise a run of several unsponsored chunks near the reserve line could
 * each look affordable in isolation while collectively overdrawing it.
 */
export function packFusedCloseTransactions(
  sdkAccount: Account,
  input: FusedCloseInput,
  network: Network,
  validUntilLedger: number,
  feeAffordability: Pick<AccountState, "nativeBalanceLumens" | "numSubEntries" | "numSponsoring">
): CloseTransaction[] {
  const tagged = assembleFusedCloseOpsTagged(sdkAccount.accountId(), input);
  const chunks = batchItems(tagged, OP_BATCH_LIMIT);
  const networkPassphrase = NETWORK_PASSPHRASES[network];
  const fullSummary = buildSummary(input);
  const reserve = reserveStroops(feeAffordability.numSubEntries, feeAffordability.numSponsoring);
  let remainingBalanceStroops = BigInt(xlmToStroops(feeAffordability.nativeBalanceLumens));

  return chunks.map((chunk, i): CloseTransaction => {
    const isLast = i === chunks.length - 1;
    const sourceSequence = sdkAccount.sequenceNumber();

    // The SDK multiplies `fee` by the operation count, so the per-operation base
    // fee yields BASE_FEE_STROOPS * opCount on-chain.
    const chunkFeeStroops = BigInt(BASE_FEE_STROOPS) * BigInt(chunk.length);
    const needsSponsoredFee = remainingBalanceStroops - reserve < chunkFeeStroops;
    // Only an unsponsored chunk spends the account's own balance on its fee - a sponsored
    // chunk's fee is "0" and paid by the fee account instead, so it doesn't reduce what later
    // chunks in this round have left to draw on.
    if (!needsSponsoredFee) {
      remainingBalanceStroops -= chunkFeeStroops;
    }
    const builder = new TransactionBuilder(sdkAccount, {
      fee: needsSponsoredFee ? "0" : String(BASE_FEE_STROOPS),
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
      ...(needsSponsoredFee ? { needsSponsoredFee: true } : {}),
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
