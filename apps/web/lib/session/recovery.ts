import { listSessions, deleteSession } from "./store";
import type { SessionRecord } from "@/types/session";
import type { Network } from "@/config/networks";

export async function findResumableSession(network: Network): Promise<SessionRecord | null> {
  try {
    const sessions = await listSessions();
    const matching = sessions
      .filter((s) => s.network === network && s.status === "in_progress")
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

export async function cleanupSession(id: string): Promise<void> {
  try {
    await deleteSession(id);
  } catch (err) {
    if (process.env.NODE_ENV !== "production") console.warn("[session] cleanup failed:", err);
  }
}
