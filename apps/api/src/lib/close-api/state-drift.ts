import type { AccountState, TrustlineAuthorization } from "@lumenwipe/types";
import type { getRpcServer } from "@/lib/stellar/rpc";
import {
  LIVE_LEDGER_LABEL,
  poolShareKey,
  readLiveLedger,
  type LiveLedger,
} from "@/lib/stellar/live-ledger";
import { LiveReadError } from "@/lib/stellar/live-trustline";
import { xlmToStroops } from "@/lib/utils/amounts";
import { AccountStateChangedError } from "@/lib/utils/errors";

/** Weighted signers as `key:weight`, sorted; the master key counts like any other signer, and a
 *  zero weight (a master key switched off) holds no signing power, so it is left out. */
function signerSet(signers: Array<{ key: string; weight: number }>): string {
  return signers
    .filter((s) => s.weight > 0)
    .map((s) => `${s.key}:${s.weight}`)
    .sort()
    .join(",");
}

function findAccountDrift(state: AccountState, live: LiveLedger): string | null {
  const { account } = live;
  if (!account) return "account no longer exists";
  if (account.sequence !== state.sequence) {
    return `sequence ${state.sequence} enumerated, ${account.sequence} on the ledger`;
  }
  if (account.numSubEntries !== state.numSubEntries) {
    return `${state.numSubEntries} sub-entries enumerated, ${account.numSubEntries} on the ledger`;
  }
  if (account.balance !== BigInt(xlmToStroops(state.nativeBalanceLumens))) {
    return "XLM balance changed";
  }
  const { low, med, high, master } = account.thresholds;
  if (
    low !== state.thresholds.low ||
    med !== state.thresholds.med ||
    high !== state.thresholds.high
  ) {
    return "thresholds changed";
  }
  const ledgerSigners = [...account.signers, { key: state.address, weight: master }];
  if (signerSet(ledgerSigners) !== signerSet(state.signers)) return "signers changed";
  return null;
}

const AUTHORIZED_FLAG = 1;
const AUTHORIZED_TO_MAINTAIN_LIABILITIES_FLAG = 2;

function authorizationOf(flags: number): TrustlineAuthorization {
  if (flags & AUTHORIZED_FLAG) return "authorized";
  return flags & AUTHORIZED_TO_MAINTAIN_LIABILITIES_FLAG ? "maintain_liabilities" : "unauthorized";
}

function findEntryDrift(state: AccountState, live: LiveLedger): string | null {
  for (const tl of state.trustlines) {
    const line = live.trustlines.get(tl.asset);
    if (!line) return `trustline ${tl.asset} no longer exists`;
    if (line.balance !== BigInt(xlmToStroops(tl.balance))) return `${tl.asset} balance changed`;
    if (tl.limit !== undefined && line.limit !== BigInt(xlmToStroops(tl.limit))) {
      return `${tl.asset} limit changed`;
    }
    if (authorizationOf(line.flags) !== tl.authorization) {
      return `${tl.asset} authorization changed`;
    }
  }
  for (const share of state.poolShares) {
    if (!live.trustlines.has(poolShareKey(share.poolId))) {
      return `pool share ${share.poolId} no longer exists`;
    }
  }
  for (const offer of state.openOffers) {
    const entry = live.offers.get(offer.id);
    if (!entry) return `offer ${offer.id} no longer exists`;
    if (
      entry.amount !== BigInt(xlmToStroops(offer.amount)) ||
      entry.selling !== offer.selling ||
      entry.buying !== offer.buying
    ) {
      return `offer ${offer.id} changed`;
    }
  }
  for (const entry of state.dataEntries) {
    const value = live.data.get(entry.key);
    if (value === undefined) return `data entry ${entry.key} no longer exists`;
    if (value !== entry.value) return `data entry ${entry.key} changed`;
  }
  return null;
}

/**
 * The first way the ledger disagrees with the enumerated `state`, or null when it agrees. Pure:
 * the comparison is against the state this same round enumerated, so a change an earlier round
 * made is already in `state` and never reads as drift. An entry added since the read is caught by
 * the sub-entry count; one changed or removed, by its own entry.
 */
export function findStateDrift(state: AccountState, live: LiveLedger): string | null {
  return findAccountDrift(state, live) ?? findEntryDrift(state, live);
}

/**
 * Confirms the enumerated state against the ledger over RPC and returns the sequence to build on.
 * Throws `AccountStateChangedError` on any disagreement and `LiveReadError` when the read fails.
 * With `gateLateRpc`, a disagreement from an RPC still behind the snapshot is that same failed
 * read: the provider has not reached the state, which says nothing about the account.
 */
export async function confirmLedgerState(
  state: AccountState,
  server: Pick<ReturnType<typeof getRpcServer>, "getLedgerEntries">,
  gateLateRpc = false
): Promise<string> {
  const live = await readLiveLedger(server, state);
  const drift = findStateDrift(state, live);
  if (drift === null) return state.sequence;
  const { latestLedger } = live;
  const { snapshotLedger } = state;
  if (
    gateLateRpc &&
    latestLedger !== undefined &&
    snapshotLedger !== undefined &&
    latestLedger < snapshotLedger
  ) {
    throw new LiveReadError(LIVE_LEDGER_LABEL);
  }
  throw new AccountStateChangedError(drift);
}
