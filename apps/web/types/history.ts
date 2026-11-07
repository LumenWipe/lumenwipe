import type { Network } from "@/config/networks";
import type { SessionRecord } from "@/types/session";

/** Closed when the merge confirmed; incomplete when some steps confirmed but the merge did not. */
export type ReceiptOutcome = "closed" | "incomplete";

/** One line of a "what was done" group, as the receipt shows it. */
export interface ReceiptItem {
  text: string;
  detail?: string;
  /** The text is an address or a key, shown in the monospace face. */
  mono?: boolean;
}

/** One "what was done" group of the receipt, as plain data. */
export interface ReceiptGroup {
  type: string;
  title: string;
  summary: string;
  items: ReceiptItem[];
  note?: string;
}

/** One confirmed transaction and the phases it carried out. */
export interface ReceiptTransaction {
  txHash: string;
  label: string;
  stepTypes: string[];
  stepTitles: string[];
}

/** The memo the close was sent with: `text` is null when it had none. */
export interface ReceiptMemo {
  text: string | null;
  type: SessionRecord["memoType"];
}

/**
 * The receipt of a close, kept in this browser's history. It shares the saved close's version
 * field and constant. A field that is null was not recorded: an entry written before it existed,
 * or an amount not looked up yet. Never a secret, a signed envelope or an unsigned transaction.
 */
export interface ReceiptRecord extends Pick<
  SessionRecord,
  "version" | "id" | "network" | "sourceAddress" | "destinationAddress" | "mediatorRequired"
> {
  outcome: ReceiptOutcome;
  /** UTC, ISO 8601. */
  completedAt: string;
  memo: ReceiptMemo | null;
  transactions: ReceiptTransaction[];
  groups: ReceiptGroup[] | null;
  /** The network fees of the confirmed transactions. */
  feeLumens: string | null;
  /** The XLM delivered at the destination, read from the confirmed result. */
  receivedLumens: string | null;
}

/** A history entry as written before the record carried a version. */
export interface LegacyHistoryEntry {
  id: string;
  network: Network;
  sourceAddress: string;
  destinationAddress: string;
  completedAt: string;
  txReceipts: { type: string; title: string; txHash: string }[];
  totalFeeLumens: string;
  usedMediator: boolean;
}
