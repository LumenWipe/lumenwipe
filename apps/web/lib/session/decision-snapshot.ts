import { isValidGAddress } from "@/lib/utils/validation";
import type { Network } from "@/config/networks";
import type { AccountState } from "@/types/account";
import type { AssetDisposition, ClaimableBalanceSelection } from "@/types/plan";

/** The shape of a saved snapshot. One from another version is not restored. */
export const DECISIONS_VERSION = 1;

const PREFIX = "lumenwipe:decisions:";

/** What this tab keeps of a close's inputs across a reload: the user's own answers, never a key,
 *  a signature, a transaction, the plan or anything the close sent. */
export interface DecisionSnapshot {
  v: number;
  network: Network;
  source: string;
  destination: string | null;
  memo: string | null;
  memoType: "text" | "id" | "hash" | null;
  destinationAcknowledgedFor: string | null;
  defiPositionsAcknowledgedFor: string | null;
  issuerSupplyAcknowledgedFor: string | null;
  positionsLeftBehind: string[];
  assetDispositions: Record<string, AssetDisposition>;
  transferDestinations: Record<string, string>;
  claimableBalanceSelections: Record<string, ClaimableBalanceSelection>;
  /** What each decided asset looked like when it was decided, so a changed one is asked again. */
  seen: Record<string, string>;
}

export type SnapshotRead =
  | { kind: "restored"; snapshot: DecisionSnapshot }
  | { kind: "none" }
  | { kind: "failed"; reason: string };

export const UNREADABLE = "this tab's saved choices could not be read";
export const OTHER_VERSION = "this tab's saved choices are from another version of LumenWipe";
export const OTHER_ACCOUNT = "this tab's saved choices are for another account";
export const NOTHING_SAVED = "this tab had no saved choices to restore";

const DISPOSITIONS: readonly string[] = ["convert", "issuer", "transfer", "leave"];
const SELECTIONS: readonly string[] = ["claim", "add_trustline_then_claim", "forfeit"];
const MEMO_TYPES: readonly unknown[] = ["text", "id", "hash", null];

function keyOf(network: Network, source: string): string {
  return `${PREFIX}${network}:${source}`;
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** How an asset looks on the account: its balance, or for one only a claimable balance brings,
 *  the balances that bring it. Null when the account holds nothing of it. */
export function assetFingerprint(account: AccountState, asset: string): string | null {
  const line = account.trustlines.find((t) => t.asset === asset);
  if (line) return `line:${line.balance}`;
  const token = account.sorobanTokens?.tokens.find((t) => t.contract === asset);
  if (token) return `token:${token.balance}`;
  const claims = account.claimableBalances
    .filter((b) => b.asset === asset)
    .map((b) => `${b.id}=${b.amount}`)
    .sort();
  return claims.length > 0 ? `claim:${claims.join(",")}` : null;
}

function isRecordOf(value: unknown, valid: (v: unknown) => boolean): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(valid)
  );
}

const isNullableString = (v: unknown) => v === null || typeof v === "string";
const isNullableAddress = (v: unknown) =>
  v === null || (typeof v === "string" && isValidGAddress(v));

/** The snapshot's own fields, each checked; anything else it carries is dropped. */
function parse(raw: unknown, network: Network, source: string): SnapshotRead {
  if (typeof raw !== "object" || raw === null) return { kind: "failed", reason: UNREADABLE };
  const s = raw as Record<string, unknown>;
  if (s.v !== DECISIONS_VERSION) return { kind: "failed", reason: OTHER_VERSION };
  if (s.network !== network || s.source !== source) {
    return { kind: "failed", reason: OTHER_ACCOUNT };
  }
  const valid =
    isNullableAddress(s.destination) &&
    isNullableString(s.memo) &&
    MEMO_TYPES.includes(s.memoType) &&
    isNullableString(s.destinationAcknowledgedFor) &&
    isNullableString(s.defiPositionsAcknowledgedFor) &&
    isNullableString(s.issuerSupplyAcknowledgedFor) &&
    Array.isArray(s.positionsLeftBehind) &&
    s.positionsLeftBehind.every((id) => typeof id === "string") &&
    isRecordOf(s.assetDispositions, (v) => DISPOSITIONS.includes(v as string)) &&
    isRecordOf(s.transferDestinations, (v) => typeof v === "string" && isValidGAddress(v)) &&
    isRecordOf(s.claimableBalanceSelections, (v) => SELECTIONS.includes(v as string)) &&
    isRecordOf(s.seen, (v) => typeof v === "string");
  if (!valid) return { kind: "failed", reason: UNREADABLE };
  return {
    kind: "restored",
    snapshot: {
      v: DECISIONS_VERSION,
      network,
      source,
      destination: s.destination as string | null,
      memo: s.memo as string | null,
      memoType: s.memoType as DecisionSnapshot["memoType"],
      destinationAcknowledgedFor: s.destinationAcknowledgedFor as string | null,
      defiPositionsAcknowledgedFor: s.defiPositionsAcknowledgedFor as string | null,
      issuerSupplyAcknowledgedFor: s.issuerSupplyAcknowledgedFor as string | null,
      positionsLeftBehind: s.positionsLeftBehind as string[],
      assetDispositions: s.assetDispositions as Record<string, AssetDisposition>,
      transferDestinations: s.transferDestinations as Record<string, string>,
      claimableBalanceSelections: s.claimableBalanceSelections as Record<
        string,
        ClaimableBalanceSelection
      >,
      seen: s.seen as Record<string, string>,
    },
  };
}

export function readDecisions(network: Network, source: string): SnapshotRead {
  const store = storage();
  if (!store) return { kind: "failed", reason: UNREADABLE };
  try {
    const raw = store.getItem(keyOf(network, source));
    if (raw === null) return { kind: "none" };
    return parse(JSON.parse(raw), network, source);
  } catch {
    return { kind: "failed", reason: UNREADABLE };
  }
}

export type SavedSource =
  { kind: "found"; source: string } | { kind: "none" } | { kind: "failed"; reason: string };

/** The account this tab last saved choices for on this network, read from the key itself so even
 *  an unreadable value still names it. */
export function savedSource(network: Network): SavedSource {
  const store = storage();
  if (!store) return { kind: "failed", reason: UNREADABLE };
  try {
    const prefix = `${PREFIX}${network}:`;
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key?.startsWith(prefix)) return { kind: "found", source: key.slice(prefix.length) };
    }
    return { kind: "none" };
  } catch {
    return { kind: "failed", reason: UNREADABLE };
  }
}

/** Saves the snapshot as this network's only one: another account's is dropped. */
export function writeDecisions(snapshot: DecisionSnapshot): void {
  const store = storage();
  if (!store) return;
  try {
    const key = keyOf(snapshot.network, snapshot.source);
    const prefix = `${PREFIX}${snapshot.network}:`;
    const others: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k?.startsWith(prefix) && k !== key) others.push(k);
    }
    others.forEach((k) => store.removeItem(k));
    store.setItem(key, JSON.stringify(snapshot));
  } catch {
    // A tab that cannot save keeps today's behaviour: a reload asks for the choices again.
  }
}

/** Drops every saved snapshot of this tab. */
export function forgetDecisions(): void {
  const store = storage();
  if (!store) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k?.startsWith(PREFIX)) keys.push(k);
    }
    keys.forEach((k) => store.removeItem(k));
  } catch {
    // Nothing to drop from storage that cannot be read.
  }
}
