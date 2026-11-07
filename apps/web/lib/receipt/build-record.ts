import type { Network } from "@/config/networks";
import { receiptAssetSummary, receiptTokenSummary } from "@/lib/api/close-decisions";
import { describeDefiPosition, positionContracts } from "@/lib/plan/describe-position";
import { shortAddr } from "@/lib/utils/short-id";
import { buildTxLedger, labelForTx } from "@/lib/utils/txLedger";
import type { useDemolishStore } from "@/store/demolish";
import type { ReceiptGroup, ReceiptOutcome, ReceiptRecord } from "@/types/history";
import type { AssetDisposition, PlannedStep } from "@/types/plan";
import { RECORD_VERSION } from "@/types/session";

/** What the receipt is built from: the close the store holds. Never the key, the signer or a
 *  transaction envelope, which the record must not carry. */
export type ReceiptSource = Pick<
  ReturnType<typeof useDemolishStore.getState>,
  | "executionPlan"
  | "sourceAddress"
  | "destinationAddress"
  | "memo"
  | "memoType"
  | "mediatorRequired"
  | "accountState"
  | "assetDispositions"
  | "transferDestinations"
  | "claimableBalanceSelections"
>;

export const CLOSING_STEPS: readonly string[] = ["MERGE", "CLOSE_ACCOUNT"];

export function confirmedStepsOf(plan: readonly PlannedStep[]): PlannedStep[] {
  return plan.filter((s) => s.status === "confirmed" && !!s.txHash);
}

/** Closed only when a merge step confirmed; anything less is incomplete. */
export function outcomeOf(plan: readonly PlannedStep[]): ReceiptOutcome {
  return confirmedStepsOf(plan).some((s) => CLOSING_STEPS.includes(s.type))
    ? "closed"
    : "incomplete";
}

/** The fees of the confirmed transactions, or null when one of them has no fee recorded. */
export function confirmedFeeLumens(plan: readonly PlannedStep[]): string | null {
  const confirmed = confirmedStepsOf(plan);
  if (confirmed.some((s) => s.actualFeeLumens === undefined)) return null;
  return confirmed.reduce((sum, s) => sum + parseFloat(s.actualFeeLumens!), 0).toFixed(7);
}

function assetCode(asset: string): string {
  return asset === "native" ? "XLM" : asset.split(":")[0];
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function dispositionLabel(disposition: AssetDisposition | null, destination?: string): string {
  // "transfer" is named, not folded into the fallback: it is the one disposition that sent the
  // balance to a third party, the outcome a user is most likely to need to look up later.
  switch (disposition) {
    case "issuer":
      return "returned to issuer";
    case "convert":
      return "swapped to XLM";
    case "transfer":
      return destination ? `sent to ${shortAddr(destination)}` : "sent to another account";
    case "leave":
      return "left with this address";
    default:
      return "resolved";
  }
}

/** The "what was done" groups of a close, as plain data. */
export function buildReceiptGroups(source: ReceiptSource, outcome: ReceiptOutcome): ReceiptGroup[] {
  const confirmedSteps = confirmedStepsOf(source.executionPlan);
  const account = source.accountState;
  const groups: ReceiptGroup[] = [];

  if (account) {
    // Only positions a confirmed exit step actually left. A position the user exited by hand in
    // between is skipped by the API as already gone and must not be reported as LumenWipe's doing.
    const exitedContracts = new Set(
      confirmedSteps
        .filter((s) => s.type === "EXIT_POSITIONS")
        .map((s) => s.affectedContract)
        .filter((c): c is string => typeof c === "string")
    );
    const positions = account.defiPositions.positions.filter((p) =>
      exitedContracts.has(p.contractAddress)
    );
    if (positions.length > 0) {
      const contracts = positionContracts(positions);
      groups.push({
        type: "EXIT_POSITIONS",
        title: "DeFi positions exited",
        summary: `${plural(positions.length, "position", "positions")} in ${plural(contracts.length, "pool", "pools")}, settled and withdrawn before the close`,
        items: positions.map((p) => ({
          text: describeDefiPosition(p, account.defiPositions.enrichment),
          detail: p.display?.pool ? undefined : shortAddr(p.contractAddress),
        })),
      });
    }

    const extraSigners = account.signers.filter((s) => s.key !== account.address);
    if (extraSigners.length > 0) {
      groups.push({
        type: "NORMALIZE_SIGNERS",
        title: "Signers removed",
        summary: `${plural(extraSigners.length, "extra signer", "extra signers")}, thresholds reset`,
        items: extraSigners.map((s) => ({
          text: shortAddr(s.key),
          detail: `weight ${s.weight}`,
          mono: true,
        })),
      });
    }

    if (account.dataEntries.length > 0) {
      groups.push({
        type: "REMOVE_DATA_ENTRIES",
        title: "Data removed",
        summary: plural(account.dataEntries.length, "data entry", "data entries"),
        items: account.dataEntries.map((d) => ({ text: d.key, mono: true })),
      });
    }

    if (account.openOffers.length > 0) {
      groups.push({
        type: "CANCEL_OFFERS",
        title: "Offers cancelled",
        summary: plural(account.openOffers.length, "open offer", "open offers"),
        items: account.openOffers.map((o) => ({
          text: `${o.amount} ${assetCode(o.selling)} → ${assetCode(o.buying)}`,
        })),
      });
    }

    // A balance explicitly forfeited was never claimed: it must not read as claimed.
    const claimedBalances = account.claimableBalances.filter(
      (b) => source.claimableBalanceSelections[b.id] !== "forfeit"
    );
    if (claimedBalances.length > 0) {
      groups.push({
        type: "CLAIM_BALANCES",
        title: "Balances claimed",
        summary: plural(claimedBalances.length, "claimable balance", "claimable balances"),
        items: claimedBalances.map((b) => ({ text: `${b.amount} ${assetCode(b.asset)}` })),
      });
    }

    // The list comes from receiptAssetSummary, not from load-time trustlines: an asset the close
    // claimed into existence held nothing when the page was analyzed, and building from that
    // state left it out of the record, including a balance returned to its issuer.
    const { handledAssets, removedTrustlines } = receiptAssetSummary(
      account,
      source.claimableBalanceSelections,
      Object.keys(source.assetDispositions)
    );
    // Soroban tokens sit in the same list: the receipt is the one record of a balance left behind.
    const handledBalances = [...handledAssets, ...receiptTokenSummary(account)];
    const assetSteps = confirmedSteps.filter((s) => s.type === "HANDLE_ASSETS");

    // Prefer the recorded dispositions; fall back to the HANDLE_ASSETS steps' fallbackToIssuer
    // flag when there are none, as for a recovered stepwise run.
    const dispositionFor = (asset: string): AssetDisposition | null => {
      const recorded = source.assetDispositions[asset];
      if (recorded) return recorded;
      const step = assetSteps.find((s) => s.affectedAsset === asset);
      if (step) return step.fallbackToIssuer ? "issuer" : "convert";
      return null;
    };

    if (handledBalances.length > 0) {
      groups.push({
        type: "HANDLE_ASSETS",
        title: "Assets handled",
        summary: `${plural(handledBalances.length, "asset", "assets")} with a balance`,
        items: handledBalances.map((b) => ({
          text: `${b.code} → ${dispositionLabel(dispositionFor(b.asset), source.transferDestinations[b.asset])}`,
        })),
      });
    }

    if (removedTrustlines.length > 0) {
      groups.push({
        type: "REMOVE_TRUSTLINES",
        title: "Trustlines removed",
        summary: plural(removedTrustlines.length, "trustline", "trustlines"),
        items: removedTrustlines.map((t) => ({ text: t.code })),
      });
    }
  }

  if (outcome === "closed") {
    const destination = source.destinationAddress;
    groups.push({
      type: "MERGE",
      title: "Account merged",
      summary: destination
        ? source.mediatorRequired
          ? `via relay account to ${shortAddr(destination)}`
          : `to ${shortAddr(destination)}`
        : "merged to destination",
      items: destination
        ? [{ text: shortAddr(destination), detail: "destination", mono: true }]
        : [],
      note: source.mediatorRequired
        ? "The merge was routed through a shared relay account, which passes your funds on to the exchange, as a co-signed transfer."
        : "The account was merged into the destination and removed from the Stellar ledger.",
    });
  }

  return groups;
}

interface ReceiptIdentity {
  id: string;
  network: Network;
  completedAt: string;
}

/**
 * The receipt of the close the store holds, from its confirmed steps. Each field is picked by
 * name, so nothing the store holds beyond them, such as a transaction envelope, is ever stored.
 * Null when the store holds no addresses to build one for.
 */
export function buildReceiptRecord(
  source: ReceiptSource,
  { id, network, completedAt }: ReceiptIdentity
): ReceiptRecord | null {
  if (!source.sourceAddress || !source.destinationAddress) return null;
  const outcome = outcomeOf(source.executionPlan);
  return {
    version: RECORD_VERSION,
    id,
    network,
    sourceAddress: source.sourceAddress,
    destinationAddress: source.destinationAddress,
    mediatorRequired: source.mediatorRequired,
    outcome,
    completedAt,
    memo: { text: source.memo, type: source.memoType },
    transactions: buildTxLedger(confirmedStepsOf(source.executionPlan)).map((tx) => ({
      txHash: tx.txHash,
      label: labelForTx(tx),
      stepTypes: [...tx.stepTypes],
      stepTitles: [...tx.stepTitles],
    })),
    groups: buildReceiptGroups(source, outcome),
    feeLumens: confirmedFeeLumens(source.executionPlan),
    receivedLumens: null,
  };
}
