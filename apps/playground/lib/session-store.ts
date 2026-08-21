import "server-only";
import { kv } from "@vercel/kv";
import { v4 as uuidv4 } from "uuid";

// Server-only custodial session storage for the testnet playground.
// Secrets are stored AES-256-GCM-encrypted (see ./crypto). Sessions expire
// after SESSION_TTL_SECONDS; every playground action refreshes the TTL.

export const SESSION_TTL_SECONDS = 3600;

export interface EphemeralIssuer {
  publicKey: string;
  encSecret: string;
  assetCode: string;
}

export interface PlaygroundSession {
  id: string;
  demoPublic: string;
  encDemoSecret: string;
  ephemeralIssuers: EphemeralIssuer[];
  completedMessSteps: string[];
  /** Confirmed demolish transaction hashes, appended as runClose's onConfirmed fires -
   *  lets the frontend animate progress by polling session state instead of a
   *  per-round HTTP call. */
  demolishLog: { txId: string; hash: string }[];
  demolishDone: boolean;
  createdAt: number;
  fundRareAssets: string[];
  offerCount: number;
  dataEntryCount: number;
}

const sessionKey = (id: string) => `playground:session:${id}`;

function isKvConfigured(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

// Dev-only fallback so the playground works locally without Vercel KV.
// Not used in production: there we fail loudly instead of silently losing
// sessions across serverless instances.
const memoryStore = new Map<string, { session: PlaygroundSession; expiresAt: number }>();
let warnedMemoryFallback = false;

export class PlaygroundStoreUnavailableError extends Error {
  constructor() {
    super("Playground session store (Vercel KV) is not configured");
    this.name = "PlaygroundStoreUnavailableError";
  }
}

function assertStoreAvailable(): void {
  if (isKvConfigured()) return;
  if (process.env.NODE_ENV === "production") {
    throw new PlaygroundStoreUnavailableError();
  }
  if (!warnedMemoryFallback) {
    warnedMemoryFallback = true;
    console.warn(
      "[playground] KV not configured - using in-memory session store (dev/test only). " +
        "Sessions are lost on server restart."
    );
  }
}

export async function createSession(
  data: Omit<PlaygroundSession, "id" | "createdAt">
): Promise<PlaygroundSession> {
  assertStoreAvailable();
  const session: PlaygroundSession = { ...data, id: uuidv4(), createdAt: Date.now() };
  await saveSession(session);
  return session;
}

export async function loadSession(id: string): Promise<PlaygroundSession | null> {
  assertStoreAvailable();
  if (!isKvConfigured()) {
    const entry = memoryStore.get(sessionKey(id));
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      memoryStore.delete(sessionKey(id));
      return null;
    }
    return entry.session;
  }
  return kv.get<PlaygroundSession>(sessionKey(id));
}

/** Persists the session and refreshes its TTL. */
export async function saveSession(session: PlaygroundSession): Promise<void> {
  assertStoreAvailable();
  if (!isKvConfigured()) {
    memoryStore.set(sessionKey(session.id), {
      session,
      expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,
    });
    return;
  }
  await kv.set(sessionKey(session.id), session, { ex: SESSION_TTL_SECONDS });
}

export async function deleteSession(id: string): Promise<void> {
  assertStoreAvailable();
  if (!isKvConfigured()) {
    memoryStore.delete(sessionKey(id));
    return;
  }
  await kv.del(sessionKey(id));
}

/** Seconds until the session expires (for the client countdown). */
export function sessionExpiresAt(): number {
  return Date.now() + SESSION_TTL_SECONDS * 1000;
}
