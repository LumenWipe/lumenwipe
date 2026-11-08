import type { AccountState } from "@lumenwipe/types";
import { BASE_FEE_STROOPS, BASE_RESERVE_XLM, CLAIM_ROUND_BATCH_SIZE } from "@/config/constants";
import { feeFloorStroops } from "@/lib/stellar/claim-reserve";
import { splitCloseOps } from "@/lib/stellar/tx-builder/close-operations";
import {
  computeNeedsSignerNormalization,
  normalizesSignersFirst,
  signerNormalizationOpCount,
} from "@/lib/stellar/tx-builder/signers";
import { xlmToStroops } from "@/lib/utils/amounts";

/** A transaction's fee, and whether the fee sponsor's rule accepts every operation in it. */
export interface FeeChunk {
  fee: bigint;
  sponsorable: boolean;
}

export interface FeePacking {
  /** Per transaction, whether the sponsor pays its fee. */
  sponsored: boolean[];
  /** What the account is short of for the fees no sponsor pays, or 0n. */
  shortStroops: bigint;
}

/**
 * Who pays each transaction of a round. The account always pays a transaction the sponsor would
 * refuse, and what later rounds will need from it, so what it holds above its floor is kept for
 * those first. A transaction the sponsor accepts is paid by the account only from what is left
 * beyond that, and sponsored otherwise. Short exactly when those kept fees exceed the spare.
 */
export function packFees(
  spareStroops: bigint,
  chunks: FeeChunk[],
  laterOwnStroops: bigint
): FeePacking {
  let kept = chunks.reduce((sum, c) => (c.sponsorable ? sum : sum + c.fee), laterOwnStroops);
  if (kept > 0n && kept > spareStroops) {
    return { sponsored: chunks.map(() => false), shortStroops: kept - spareStroops };
  }
  let spare = spareStroops;
  const sponsored = chunks.map((c) => {
    if (!c.sponsorable) {
      spare -= c.fee;
      kept -= c.fee;
      return false;
    }
    if (spare - kept >= c.fee) {
      spare -= c.fee;
      return false;
    }
    return true;
  });
  return { sponsored, shortStroops: 0n };
}

function chunksOf(sponsorable: boolean[], sponsorConfigured: boolean): FeeChunk[] {
  return splitCloseOps(sponsorable).map((ops) => ({
    fee: BigInt(BASE_FEE_STROOPS) * BigInt(ops.length),
    sponsorable: sponsorConfigured && ops.every(Boolean),
  }));
}

function ownFees(chunks: FeeChunk[]): bigint {
  return chunks.reduce((sum, c) => (c.sponsorable ? sum : sum + c.fee), 0n);
}

function repeat(count: number, sponsorable: boolean): boolean[] {
  return Array.from({ length: count }, () => sponsorable);
}

/**
 * Per operation of the round that closes the account, in the order `assembleCloseOpsTagged`
 * emits them, whether the sponsor's rule accepts it. Revoking a sponsorship, or paying an asset
 * to its issuer or to another account, is never sponsored; the rest of a close is.
 */
export function closeRoundSponsorable(
  state: AccountState,
  dispositions: Readonly<Record<string, string>>,
  viaMediator: boolean,
  withNormalization: boolean,
  claimed: ReadonlySet<string> = new Set(),
  opened: readonly string[] = []
): boolean[] {
  const revoked = state.sponsorshipEnumerationIncomplete
    ? 0
    : state.sponsoredEntries.filter((e) => e.kind !== "claimable_balance").length;
  const handled = [
    ...state.trustlines
      .filter((t) => BigInt(xlmToStroops(t.balance)) > 0n || claimed.has(t.asset))
      .map((t) => t.asset),
    ...opened,
  ];
  return [
    ...(withNormalization
      ? repeat(signerNormalizationOpCount(state.signers, state.address), true)
      : []),
    ...repeat(revoked, false),
    ...repeat(state.dataEntries.length + state.openOffers.length, true),
    ...handled.map((asset) => (dispositions[asset] ?? "convert") === "convert"),
    ...repeat(state.trustlines.length + opened.length, true),
    ...(viaMediator ? [] : [true]),
  ];
}

export interface ClassicFeeProjection {
  /** What the account is short of for every fee no sponsor will pay, from this round on. */
  shortStroops: bigint;
  /** Whether the round that closes the account carries a transaction the sponsor would refuse. */
  closeRoundRefused: boolean;
  /** What a normalization round, or a claim round, must leave the account for the rounds after it. */
  laterOwnStroops: { afterNormalization: bigint; afterClaims: bigint };
}

/**
 * The classic rounds still ahead of this state, as the build will pack them: signer normalization
 * when it comes first, the claims (one round's batch, as the plan's reserve check counts them),
 * then the close. Each claim round's new trustlines raise the
 * floor by a base reserve and are disposed of and removed in the close. XLM a claim brings in is
 * not counted, since another claimant can take the balance first, so the projection can only ask
 * for more than the build needs, never less.
 */
export function projectClassicFees(
  state: AccountState,
  dispositions: Readonly<Record<string, string>>,
  claimSelections: Readonly<Record<string, string>>,
  viaMediator: boolean,
  sponsorConfigured: boolean
): ClassicFeeProjection {
  const first = normalizesSignersFirst(state);
  const normalization = first
    ? chunksOf(
        repeat(signerNormalizationOpCount(state.signers, state.address), true),
        sponsorConfigured
      )
    : [];

  const usable = new Set(state.trustlines.filter((t) => t.authorized).map((t) => t.asset));
  const due = state.claimableBalances.filter((b) => {
    const selection = claimSelections[b.id];
    if (selection === "forfeit") return false;
    return b.asset === "native" || usable.has(b.asset) || selection === "add_trustline_then_claim";
  });
  const toAdd = new Set(
    due.filter((b) => b.asset !== "native" && !usable.has(b.asset)).map((b) => b.asset)
  );
  const claims = chunksOf(
    [...repeat(toAdd.size, false), ...repeat(Math.min(due.length, CLAIM_ROUND_BATCH_SIZE), true)],
    sponsorConfigured
  );

  const held = new Set(state.trustlines.map((t) => t.asset));
  const opened = [...toAdd].filter((asset) => !held.has(asset));
  const claimed = new Set(due.filter((b) => b.asset !== "native").map((b) => b.asset));
  const close = chunksOf(
    closeRoundSponsorable(
      state,
      dispositions,
      viaMediator,
      computeNeedsSignerNormalization(state) && !first,
      claimed,
      opened
    ),
    sponsorConfigured
  );

  const reserves = BigInt(xlmToStroops(BASE_RESERVE_XLM.toFixed(7))) * BigInt(opened.length);
  const afterClaims = reserves + ownFees(close);
  const afterNormalization = ownFees(claims) + afterClaims;
  const spare = BigInt(xlmToStroops(state.nativeBalanceLumens)) - feeFloorStroops(state);
  const owed = ownFees(normalization) + afterNormalization;
  return {
    shortStroops: owed > 0n && owed > spare ? owed - spare : 0n,
    closeRoundRefused: close.some((c) => !c.sponsorable),
    laterOwnStroops: { afterNormalization, afterClaims },
  };
}
