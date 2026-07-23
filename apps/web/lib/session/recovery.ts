import { listSessions, deleteSession } from "./store";
import type { SessionRecord } from "@/types/session";
import type { Network } from "@/config/networks";

export async function findResumableSession(network: Network): Promise<SessionRecord | null> {
  try {
    const sessions = await listSessions();
    const matching = sessions
      .filter((s) => s.network === network && s.status === "in_progress")
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return matching[0] ?? null;
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
