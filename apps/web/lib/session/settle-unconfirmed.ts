import { resolveSubmission, submissionClosesAccount } from "@lumenwipe/sdk";
import type { Network } from "@/config/networks";
import { clearUnconfirmedFor, deleteSession } from "@/lib/session/store";
import { lookupViaApi } from "@/lib/stellar/submit-via-api";
import { useDemolishStore } from "@/store/demolish";
import type { SessionRecord } from "@/types/session";

export type RecordedOutcome = "closed" | "failed" | "released" | "unknown";

/** Settles a saved hash by lookup alone: its envelope was never stored, so nothing can be sent. */
export async function settleRecorded(
  session: SessionRecord,
  network: Network
): Promise<RecordedOutcome> {
  if (!session.unconfirmed) return "released";
  const { outcome } = await resolveSubmission(session.unconfirmed, (hash) =>
    lookupViaApi(hash, network)
  );
  if (outcome === "unknown") return "unknown";
  useDemolishStore.getState().setUnconfirmedSubmission(null);
  await clearUnconfirmedFor(network, session.sourceAddress);
  if (outcome === "failed") return "failed";
  if (outcome === "confirmed" && submissionClosesAccount(session.unconfirmed)) {
    await deleteSession(session.id);
    return "closed";
  }
  return "released";
}
