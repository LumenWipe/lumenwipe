import { deleteSettledSession, expireSessions, isExpired, listSessions } from "./store";
import type { SessionRecord } from "@/types/session";
import type { Network } from "@/config/networks";

/** The saved close to offer for resuming on this network. Expired records are deleted first, and
 *  left out even when that delete fails. */
export async function findResumableSession(network: Network): Promise<SessionRecord | null> {
  try {
    await expireSessions().catch((err: unknown) => {
      console.error("[session] could not delete expired sessions:", err);
    });
    const sessions = await listSessions();
    const matching = sessions
      .filter((s) => s.network === network && s.status === "in_progress" && !isExpired(s))
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return matching.find((s) => s.unconfirmed) ?? matching[0] ?? null;
  } catch {
    return null;
  }
}

/** A session of this account holding a hash whose outcome is unknown, however old it is. Throws
 *  when the saved sessions cannot be read, for a caller that must not take that as no hold. */
export async function readUnresolved(
  network: Network,
  source: string
): Promise<SessionRecord | null> {
  const sessions = await listSessions();
  return (
    sessions.find((s) => s.network === network && s.sourceAddress === source && s.unconfirmed) ??
    null
  );
}

/** As readUnresolved, with a failed read taken as no hold. */
export async function findUnresolved(
  network: Network,
  source: string
): Promise<SessionRecord | null> {
  try {
    return await readUnresolved(network, source);
  } catch {
    return null;
  }
}

/** Deletes the saved closes of an account the network no longer has, and counts them. One holding
 *  an unconfirmed hash is left to its own check by hash, which is the only path that settles it. */
export async function clearRecordsOfGoneAccount(network: Network, source: string): Promise<number> {
  const sessions = await listSessions();
  const settled = sessions.filter(
    (s) => s.network === network && s.sourceAddress === source && !s.unconfirmed
  );
  const deleted = await Promise.all(settled.map((s) => deleteSettledSession(s.id)));
  return deleted.filter(Boolean).length;
}

/** Deletes a finished close's saved session, unless it holds an unconfirmed hash, which is the
 *  only pointer left to a transaction whose outcome nobody has settled. */
export async function cleanupSession(id: string): Promise<void> {
  try {
    await deleteSettledSession(id);
  } catch (err) {
    if (process.env.NODE_ENV !== "production") console.warn("[session] cleanup failed:", err);
  }
}
