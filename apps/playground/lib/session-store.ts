import "server-only";
import { v4 as uuidv4 } from "uuid";
import type { IntentOperation } from "@lumenwipe/sdk";
import { isRedisConfigured } from "./upstash-redis";
import { DEV_STORE_FILE, devFileKv, upstashKv, type SessionKv } from "./kv";

// Server-only custodial session storage for the testnet playground.
// Secrets are stored AES-256-GCM-encrypted (see ./crypto). Sessions expire
// after SESSION_TTL_SECONDS; every playground action refreshes the TTL.

export const SESSION_TTL_SECONDS = 3600;

/** Bumped whenever the stored shape changes; a session of any other version reads as expired. */
export const SESSION_SCHEMA_VERSION = 1;

/** Longer than any route's maxDuration, so a request the platform kills frees its session soon after. */
export const SESSION_LOCK_TTL_MS = 150_000;

export interface EphemeralIssuer {
  publicKey: string;
  encSecret: string;
  assetCode: string;
}

export interface DemolishLogEntry {
  txId: string;
  hash: string;
  summary: string;
  operations: IntentOperation[];
}

export interface PlaygroundSession {
  schemaVersion: typeof SESSION_SCHEMA_VERSION;
  id: string;
  demoPublic: string;
  encDemoSecret: string;
  ephemeralIssuers: EphemeralIssuer[];
  completedMessSteps: string[];
  /** Confirmed demolish transaction hashes plus each transaction's operations, so the frontend can
   *  replay the close operation-by-operation instead of only transaction-by-transaction. */
  demolishLog: DemolishLogEntry[];
  demolishDone: boolean;
  createdAt: number;
  fundRareAssets: string[];
  offerCount: number;
  dataEntryCount: number;
}

type FixedFields = "schemaVersion" | "id" | "createdAt";
export type NewSessionData = Omit<PlaygroundSession, FixedFields>;
export type SessionPatch = Partial<Omit<PlaygroundSession, FixedFields>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isEphemeralIssuer(value: unknown): value is EphemeralIssuer {
  return (
    isRecord(value) &&
    typeof value.publicKey === "string" &&
    typeof value.encSecret === "string" &&
    typeof value.assetCode === "string"
  );
}

function isDemolishLogEntry(value: unknown): value is DemolishLogEntry {
  return (
    isRecord(value) &&
    typeof value.txId === "string" &&
    typeof value.hash === "string" &&
    typeof value.summary === "string" &&
    Array.isArray(value.operations)
  );
}

/** Validates a stored session of the current schema version; anything else is treated as expired. */
export function isPlaygroundSession(value: unknown): value is PlaygroundSession {
  return (
    isRecord(value) &&
    value.schemaVersion === SESSION_SCHEMA_VERSION &&
    typeof value.id === "string" &&
    typeof value.demoPublic === "string" &&
    typeof value.encDemoSecret === "string" &&
    Array.isArray(value.ephemeralIssuers) &&
    value.ephemeralIssuers.every(isEphemeralIssuer) &&
    isStringArray(value.completedMessSteps) &&
    Array.isArray(value.demolishLog) &&
    value.demolishLog.every(isDemolishLogEntry) &&
    typeof value.demolishDone === "boolean" &&
    typeof value.createdAt === "number" &&
    isStringArray(value.fundRareAssets) &&
    typeof value.offerCount === "number" &&
    typeof value.dataEntryCount === "number"
  );
}

export interface SessionLock {
  sessionId: string;
  token: string;
}

export class PlaygroundStoreUnavailableError extends Error {
  constructor() {
    super("Playground session store (Upstash Redis) is not configured");
    this.name = "PlaygroundStoreUnavailableError";
  }
}

export class SessionLockLostError extends Error {
  constructor(sessionId: string) {
    super(`Session ${sessionId} lock expired or was taken over before the update`);
    this.name = "SessionLockLostError";
  }
}

export interface SessionStore {
  createSession(data: NewSessionData): Promise<PlaygroundSession>;
  loadSession(id: string): Promise<PlaygroundSession | null>;
  /** The one exclusive lock per session that every mutating action holds; null when it is taken. */
  acquireLock(id: string): Promise<SessionLock | null>;
  releaseLock(lock: SessionLock): Promise<void>;
  /** Read-modify-write of the session, refused with SessionLockLostError unless `lock` is still held. */
  updateSession(
    lock: SessionLock,
    patch: (session: PlaygroundSession) => SessionPatch
  ): Promise<PlaygroundSession>;
  /** Deletes the session, refused with SessionLockLostError unless `lock` is still held. */
  deleteSession(lock: SessionLock): Promise<void>;
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A session id is the uuid v4 `createSession` generates; anything else from a URL is rejected. */
export function isSessionId(value: string): boolean {
  return SESSION_ID.test(value);
}

const sessionKey = (id: string): string => `playground:session:${id}`;
const lockKey = (id: string): string => `playground:session-lock:${id}`;

export function createSessionStore(resolveKv: () => SessionKv): SessionStore {
  const loadSession = async (id: string): Promise<PlaygroundSession | null> => {
    const value = await resolveKv().get(sessionKey(id));
    return isPlaygroundSession(value) ? value : null;
  };

  return {
    async createSession(data) {
      const session: PlaygroundSession = {
        ...data,
        schemaVersion: SESSION_SCHEMA_VERSION,
        id: uuidv4(),
        createdAt: Date.now(),
      };
      await resolveKv().set(sessionKey(session.id), session, SESSION_TTL_SECONDS);
      return session;
    },
    loadSession,
    async acquireLock(id) {
      const lock = { sessionId: id, token: uuidv4() };
      const acquired = await resolveKv().acquire(lockKey(id), lock.token, SESSION_LOCK_TTL_MS);
      return acquired ? lock : null;
    },
    async releaseLock(lock) {
      await resolveKv().releaseIfHeld(lockKey(lock.sessionId), lock.token);
    },
    async updateSession(lock, patch) {
      const current = await loadSession(lock.sessionId);
      if (!current) throw new Error(`Session ${lock.sessionId} no longer exists`);
      const next: PlaygroundSession = { ...current, ...patch(current) };
      const written = await resolveKv().setIfLockHeld(
        lockKey(lock.sessionId),
        lock.token,
        sessionKey(lock.sessionId),
        next,
        SESSION_TTL_SECONDS
      );
      if (!written) throw new SessionLockLostError(lock.sessionId);
      return next;
    },
    async deleteSession(lock) {
      const deleted = await resolveKv().delIfLockHeld(
        lockKey(lock.sessionId),
        lock.token,
        sessionKey(lock.sessionId)
      );
      if (!deleted) throw new SessionLockLostError(lock.sessionId);
    },
  };
}

let warnedDevFallback = false;

// Production fails loudly without Redis instead of silently losing sessions across serverless
// instances; dev and test fall back to a file.
function resolveDefaultKv(): SessionKv {
  if (isRedisConfigured()) return upstashKv();
  if (process.env.NODE_ENV === "production") throw new PlaygroundStoreUnavailableError();
  if (!warnedDevFallback) {
    warnedDevFallback = true;
    console.warn(
      "[playground] Upstash Redis not configured - using a file-backed dev session store (dev/test only); sessions are lost when the file is removed",
      { file: DEV_STORE_FILE }
    );
  }
  return devFileKv();
}

export const sessionStore: SessionStore = createSessionStore(resolveDefaultKv);

/** Seconds until the session expires (for the client countdown). */
export function sessionExpiresAt(): number {
  return Date.now() + SESSION_TTL_SECONDS * 1000;
}
