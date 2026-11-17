/**
 * Archived Soroban entries as stellar-rpc 23+ serves them: `getLedgerEntries` still returns an
 * archived persistent entry with its last value, with a `liveUntilLedgerSeq` below
 * `latestLedger` (0 once the entry is evicted), and a simulation that touches it succeeds and
 * marks it for automatic restore (CAP-66) instead of returning a `restorePreamble`. Only a key
 * the ledger does not hold at all is missing from the answer.
 */
import { xdr, type rpc } from "@stellar/stellar-sdk";
import { v1TransactionFromXdr } from "../../support/v1-transaction";

export type EntryArchival = "live" | "evicted" | "expired";

export const ARCHIVED: ReadonlyArray<Exclude<EntryArchival, "live">> = ["evicted", "expired"];

const LATEST_LEDGER = 1_000;

/** Every entry of `answer` as it reads in `archival`; a live answer is returned unchanged. */
export function archivedAnswer(
  answer: rpc.Api.GetLedgerEntriesResponse,
  archival: EntryArchival
): rpc.Api.GetLedgerEntriesResponse {
  if (archival === "live") return answer;
  const liveUntilLedgerSeq = archival === "evicted" ? 0 : LATEST_LEDGER - 1;
  return {
    latestLedger: LATEST_LEDGER,
    entries: answer.entries.map((entry) => ({ ...entry, liveUntilLedgerSeq })),
  };
}

/** `server` with every `getLedgerEntries` answer served as `archival`. */
export function withArchivedEntries<R extends Pick<rpc.Server, "getLedgerEntries">>(
  server: R,
  archival: EntryArchival
): R {
  const inner = server.getLedgerEntries.bind(server);
  const getLedgerEntries: R["getLedgerEntries"] = async (...keys) =>
    archivedAnswer(await inner(...keys), archival);
  return Object.assign(Object.create(server) as R, { getLedgerEntries });
}

/** `data` marking the read-write footprint entries at `indexes` for automatic restore. */
export function autoRestoring(
  data: xdr.SorobanTransactionData,
  indexes: number[] = [0]
): xdr.SorobanTransactionData {
  return new xdr.SorobanTransactionData({
    resources: data.resources,
    resourceFee: data.resourceFee,
    ext: xdr.SorobanTransactionDataExt.resourceExt(
      new xdr.SorobanResourcesExtV0({ archivedSorobanEntries: indexes })
    ),
  });
}

/** The read-write footprint indexes a built transaction restores before it runs. */
export function restoredIndexes(txXdr: string): number[] {
  const tx = v1TransactionFromXdr(txXdr);
  if (tx.ext.type !== "sorobanData") return [];
  const ext = tx.ext.sorobanData.ext;
  return ext.type === "resourceExt" ? ext.resourceExt.archivedSorobanEntries : [];
}
