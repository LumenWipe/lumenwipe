import { kv } from "@vercel/kv";
import { v4 as uuidv4 } from "uuid";

// Server-only custodial session storage for the testnet playground.
// Secrets are stored AES-256-GCM-encrypted (see ./crypto). Sessions expire
// after SESSION_TTL_SECONDS; every playground action refreshes the TTL.

export const SESSION_TTL_SECONDS = 3600;
export const MAX_SIGNS_PER_SESSION = 40;

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
  signCount: number;
  createdAt: number;
  /** Which ephemeral codes to fund in the FUND_RARE step (mode-dependent). */
  fundRareAssets: string[];
  /** How many junk offers to post in the OFFERS step. */
  offerCount: number;
  /** How many junk data entries to attach in the DATA_ENTRIES step. */
  dataEntryCount: number;
}

const sessionKey = (id: string) => `playground:session:${id}`;

const kvConfigured = Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);

// Dev-only fallback so the playground works locally without Vercel KV.
// Not used in production: there we fail loudly instead of silently losing
// sessions across serverless instances.
const memoryStore = new Map<string, { session: PlaygroundSession; expiresAt: number }>();
let warnedMemoryFallback = false;

function assertStoreAvailable(): void {
  if (kvConfigured) return;
  if (process.env.NODE_ENV === "production") {
    throw new PlaygroundStoreUnavailableError();
  }
  if (!warnedMemoryFallback) {
    warnedMemoryFallback = true;
    console.warn(
      "[playground] KV not configured - using in-memory session store (dev only). " +
        "Sessions are lost on server restart."
    );
  }
}

export class PlaygroundStoreUnavailableError extends Error {
  constructor() {
    super("Playground session store (Vercel KV) is not configured");
    this.name = "PlaygroundStoreUnavailableError";
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
  if (!kvConfigured) {
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
  if (!kvConfigured) {
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
  if (!kvConfigured) {
    memoryStore.delete(sessionKey(id));
    return;
  }
  await kv.del(sessionKey(id));
}

/** Seconds until the session expires (for the client countdown). */
export function sessionExpiresAt(): number {
  return Date.now() + SESSION_TTL_SECONDS * 1000;
}
