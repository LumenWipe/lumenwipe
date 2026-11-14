import "server-only";
import { v4 as uuidv4 } from "uuid";
import type { IntentOperation } from "@lumenwipe/sdk";
import { isRedisConfigured } from "./upstash-redis";
import { DEV_STORE_FILE, devFileKv, upstashKv, type SessionKv } from "./kv";
import { parseStroops } from "./stroops";
import {
  EXCHANGE_STAND_IN,
  MAX_BATCH_SIZE,
  MIN_BATCH_SIZE,
  parseSelection,
  validateSelection,
  type ClaimIntent,
  type HelperRole,
  type ScenarioSelection,
} from "./scenarios";

// Server-only custodial session storage for the testnet playground.
// Secrets are stored AES-256-GCM-encrypted (see ./crypto). A record expires
// SESSION_RECORD_TTL_SECONDS after its last write, while the visitor's
// countdown ends at the session's stored `expiresAt`.

/** The countdown a session starts with. */
export const SESSION_COUNTDOWN_SECONDS = 3600;

/** What the one extension adds to the stored expiry. */
export const SESSION_EXTENSION_SECONDS = 1800;

/** The extension is offered, and accepted, only this close to the expiry. */
export const EXTENSION_WINDOW_SECONDS = 300;

/**
 * How long a record outlives its last write, so the reaper can still read the keys of an abandoned
 * session. On the Hobby plan the reaper runs once a day, anywhere within its hour, and a failed or
 * missed run is not retried: 72 hours covers two runs after the reap threshold.
 */
export const SESSION_RECORD_TTL_SECONDS = 72 * 3600;

/** Bumped whenever the stored shape changes; a session of any other version reads as expired. */
export const SESSION_SCHEMA_VERSION = 10;

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

/**
 * A demolish transaction handed to the network whose outcome is not settled yet, written before it
 * is sent. A later round looks its hash up instead of building it again, and logs it from this
 * record if it confirmed. `hash`, `validUntil` and `closesAccount` are computed by the playground
 * from the envelope it signed, never taken from the API.
 */
export interface PendingDemolishTx extends DemolishLogEntry {
  /** Unix seconds after which the envelope cannot land; null with no upper time bound. */
  validUntil: number | null;
  /** Whether the envelope merges the demo account away. */
  closesAccount: boolean;
  /** For an exchange session, the demo's XLM balance as the playground read it from Horizon in
   *  the round that signed this envelope: what its forward was held to, and what the delivery
   *  read from the ledger is held to once it confirms. Null otherwise. */
  recordedBalance: string | null;
}

/**
 * Where an exchange session's close deposits: the bundled registry's stand-in
 * (lib/scenarios/exchange.ts), never a value from configuration or the request, and the deposit
 * memo the session drew for it, a random uint64 sent as an id memo, the type the registry names.
 */
export interface SessionExchange {
  destination: string;
  memo: string;
  memoType: "id";
}

/** The log entry a confirmed in-flight record becomes. */
export function logEntryOf({
  txId,
  hash,
  summary,
  operations,
}: DemolishLogEntry): DemolishLogEntry {
  return { txId, hash, summary, operations };
}

/** An account the playground creates for the session to send a balance to; its secret is
 *  encrypted like the demo's, and only cleanup signs with it. */
export interface SessionAccount {
  publicKey: string;
  encSecret: string;
}

/** A playground-owned account beside the demo, used only for the role a step created it for. */
export interface HelperAccount extends SessionAccount {
  role: HelperRole;
}

/**
 * A claimable balance the mess created, with the id the playground computed from the transaction
 * it signed (never read back from Horizon or the API). `asset` is `CODE:ISSUER` or `native`.
 */
export interface RecordedClaimableBalance {
  id: string;
  asset: string;
  intent: ClaimIntent;
}

export const SIGNER_TYPES = ["ed25519_public_key", "hash_x", "preauth_tx"] as const;

export type SignerType = (typeof SIGNER_TYPES)[number];

/**
 * A signer the mess added to the demo account, as its strkey (`G...`, `X...` or `T...`) and the
 * weight it was given. `encSecret` is what signs for it, encrypted like the demo's key: an ed25519
 * co-signer's secret key or a hash(x) signer's preimage in hex. Null when nothing can sign for it:
 * a forgotten co-signer whose key was discarded, or a pre-authorized transaction.
 */
export interface RecordedSigner {
  type: SignerType;
  key: string;
  weight: number;
  encSecret: string | null;
}

/**
 * An allowance the mess approved from the demo, recorded before its `approve` is sent: the token
 * contract, the spender (a fresh public key no one holds the secret of) and the ledger it lives
 * until. A revoke may zero only an allowance recorded here, with the spender taken from here and
 * never from the API's list (lib/allowances.ts).
 */
export interface RecordedAllowance {
  token: string;
  spender: string;
  liveUntilLedger: number;
}

export interface PlaygroundSession {
  schemaVersion: typeof SESSION_SCHEMA_VERSION;
  id: string;
  demoPublic: string;
  encDemoSecret: string;
  ephemeralIssuers: EphemeralIssuer[];
  completedMessSteps: string[];
  /** The signers the mess added to the demo account. The demolish may remove these and no other
   *  signer (lib/verify.ts), and signs only with these and the demo key (lib/demolish.ts).
   *  Recorded here before the transaction that adds them is sent, never read back from the API. */
  recordedSigners: RecordedSigner[];
  /** Confirmed demolish transaction hashes plus each transaction's operations, so the frontend can
   *  replay the close operation-by-operation instead of only transaction-by-transaction. */
  demolishLog: DemolishLogEntry[];
  /** The demolish transaction in flight, if any (see PendingDemolishTx). */
  demolishPending: PendingDemolishTx | null;
  demolishDone: boolean;
  createdAt: number;
  /** When the countdown ends, in epoch milliseconds. From then on the mess and the credentials
   *  routes refuse the session; its close never does. */
  expiresAt: number;
  /** Whether the session's one extension has been used. */
  extended: boolean;
  /** The validated scenario selection. The plan, the executor's steps and the close expectation
   *  are recomputed from it on every request; nothing the client sends later can change it. */
  selection: ScenarioSelection;
  /** The account a "transfer" disposition sends to, created by the OPEN_RECIPIENT step; null when
   *  the selection transfers nothing. The close may transfer to this account and no other. */
  transferRecipient: SessionAccount | null;
  /** The claimant, sponsor or beneficiary a step created. */
  helperAccounts: HelperAccount[];
  /** Recorded before the transaction that creates them is sent, one entry per attempt. */
  claimableBalances: RecordedClaimableBalance[];
  /** The allowances the mess approved, in spender order: entry `i` is spender `i + 1`. */
  allowances: RecordedAllowance[];
  /** Where the close deposits, for a session that selected the exchange close; null otherwise. */
  exchange: SessionExchange | null;
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

function isValidSelection(value: unknown): boolean {
  const selection = parseSelection(value);
  return selection !== null && validateSelection(selection).ok;
}

function isEphemeralIssuer(value: unknown): value is EphemeralIssuer {
  return (
    isRecord(value) &&
    typeof value.publicKey === "string" &&
    typeof value.encSecret === "string" &&
    typeof value.assetCode === "string"
  );
}

function isSessionAccount(value: unknown): value is SessionAccount {
  return (
    isRecord(value) && typeof value.publicKey === "string" && typeof value.encSecret === "string"
  );
}

const HELPER_ROLES: readonly string[] = ["claimant", "sponsor", "beneficiary"];
const CLAIM_INTENTS: readonly string[] = [
  "claim",
  "add_trustline_then_claim",
  "forfeit",
  "demo_sponsored",
];

function isHelperAccount(value: unknown): value is HelperAccount {
  return (
    isSessionAccount(value) &&
    isRecord(value) &&
    typeof value.role === "string" &&
    HELPER_ROLES.includes(value.role)
  );
}

function isRecordedSigner(value: unknown): value is RecordedSigner {
  return (
    isRecord(value) &&
    SIGNER_TYPES.some((t) => t === value.type) &&
    typeof value.key === "string" &&
    typeof value.weight === "number" &&
    (value.encSecret === null || typeof value.encSecret === "string")
  );
}

function isRecordedClaimableBalance(value: unknown): value is RecordedClaimableBalance {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.asset === "string" &&
    typeof value.intent === "string" &&
    CLAIM_INTENTS.includes(value.intent)
  );
}

function isRecordedAllowance(value: unknown): value is RecordedAllowance {
  return (
    isRecord(value) &&
    typeof value.token === "string" &&
    typeof value.spender === "string" &&
    typeof value.liveUntilLedger === "number" &&
    Number.isInteger(value.liveUntilLedger) &&
    value.liveUntilLedger > 0
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

function isPendingDemolishTx(value: unknown): value is PendingDemolishTx {
  return (
    isDemolishLogEntry(value) &&
    isRecord(value) &&
    (value.validUntil === null || typeof value.validUntil === "number") &&
    typeof value.closesAccount === "boolean" &&
    (value.recordedBalance === null ||
      (typeof value.recordedBalance === "string" && parseStroops(value.recordedBalance) !== null))
  );
}

/** The largest value an id memo holds. */
const MAX_UINT64 = BigInt("18446744073709551615");

/** A uint64 as an id memo is written: decimal, no sign and no leading zero. */
export function isIdMemo(value: unknown): value is string {
  return (
    typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= MAX_UINT64
  );
}

function isSessionExchange(value: unknown): value is SessionExchange {
  return (
    isRecord(value) &&
    value.destination === EXCHANGE_STAND_IN.address &&
    isIdMemo(value.memo) &&
    value.memoType === "id"
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
    Array.isArray(value.recordedSigners) &&
    value.recordedSigners.every(isRecordedSigner) &&
    Array.isArray(value.demolishLog) &&
    value.demolishLog.every(isDemolishLogEntry) &&
    (value.demolishPending === null || isPendingDemolishTx(value.demolishPending)) &&
    typeof value.demolishDone === "boolean" &&
    typeof value.createdAt === "number" &&
    typeof value.expiresAt === "number" &&
    Number.isFinite(value.expiresAt) &&
    typeof value.extended === "boolean" &&
    isValidSelection(value.selection) &&
    (value.transferRecipient === null || isSessionAccount(value.transferRecipient)) &&
    Array.isArray(value.helperAccounts) &&
    value.helperAccounts.every(isHelperAccount) &&
    Array.isArray(value.claimableBalances) &&
    value.claimableBalances.every(isRecordedClaimableBalance) &&
    Array.isArray(value.allowances) &&
    value.allowances.every(isRecordedAllowance) &&
    (value.exchange === null || isSessionExchange(value.exchange))
  );
}

/**
 * Two or three sessions created together. The record holds member ids only: no key, encrypted or
 * not, and no expiry or progress of its own, so each member keeps its own record, lock, countdown
 * and index entry, and the reaper reclaims it like any other session.
 */
export interface PlaygroundBatch {
  schemaVersion: typeof BATCH_SCHEMA_VERSION;
  id: string;
  memberIds: string[];
  createdAt: number;
}

/** Bumped whenever the stored batch shape changes; a batch of any other version reads as gone. */
export const BATCH_SCHEMA_VERSION = 1;

/** Validates a stored batch: a batch id, and two or three distinct session ids other than it. */
export function isPlaygroundBatch(value: unknown): value is PlaygroundBatch {
  return (
    isRecord(value) &&
    value.schemaVersion === BATCH_SCHEMA_VERSION &&
    typeof value.id === "string" &&
    isSessionId(value.id) &&
    isStringArray(value.memberIds) &&
    value.memberIds.length >= MIN_BATCH_SIZE &&
    value.memberIds.length <= MAX_BATCH_SIZE &&
    value.memberIds.every(isSessionId) &&
    new Set(value.memberIds).size === value.memberIds.length &&
    !value.memberIds.includes(value.id) &&
    typeof value.createdAt === "number"
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

/** A short exclusive hold on a name outside any session (an account's submissions, the reaper). */
export interface Lease {
  key: string;
  token: string;
}

/** What the reaper's last faucet call returned, kept so a refused session can say why. */
export type FaucetFailure = "rate_limited" | "unavailable";

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
  /** Deletes the session and its index entry, refused with SessionLockLostError unless `lock` is
   *  still held. */
  deleteSession(lock: SessionLock): Promise<void>;
  /** Every session id created and not yet deleted; a record may have expired since. */
  indexedSessionIds(): Promise<string[]>;
  /** Drops an id whose record has expired from the index. */
  unindexSession(id: string): Promise<void>;
  acquireLease(name: string, ttlMs: number): Promise<Lease | null>;
  releaseLease(lease: Lease): Promise<void>;
  lastFaucetFailure(): Promise<FaucetFailure | null>;
  /** Writes a batch of sessions already created, under a fresh id of its own. */
  createBatch(memberIds: readonly string[]): Promise<PlaygroundBatch>;
  /** The batch stored under `id`, or null when there is none or it has expired. */
  loadBatch(id: string): Promise<PlaygroundBatch | null>;
  /** Records the outcome of the reaper's faucet call; null after a successful one. */
  recordFaucetFailure(failure: FaucetFailure | null): Promise<void>;
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A session id is the uuid v4 `createSession` generates; anything else from a URL is rejected.
 *  A batch id has the same shape, under a key namespace of its own. */
export function isSessionId(value: string): boolean {
  return SESSION_ID.test(value);
}

const sessionKey = (id: string): string => `playground:session:${id}`;
const lockKey = (id: string): string => `playground:session-lock:${id}`;
const leaseKey = (name: string): string => `playground:lease:${name}`;
const batchKey = (id: string): string => `playground:batch:${id}`;
const SESSION_INDEX_KEY = "playground:session-index";
const FAUCET_FAILURE_KEY = "playground:faucet-failure";
/** A faucet failure older than this no longer explains a refusal: a day's run has come since. */
const FAUCET_FAILURE_TTL_SECONDS = 26 * 3600;

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
      const kv = resolveKv();
      await kv.set(sessionKey(session.id), session, SESSION_RECORD_TTL_SECONDS);
      await kv.indexAdd(SESSION_INDEX_KEY, session.id);
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
        SESSION_RECORD_TTL_SECONDS
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
      await resolveKv().indexRemove(SESSION_INDEX_KEY, lock.sessionId);
    },
    indexedSessionIds: () => resolveKv().indexMembers(SESSION_INDEX_KEY),
    async unindexSession(id) {
      await resolveKv().indexRemove(SESSION_INDEX_KEY, id);
    },
    async acquireLease(name, ttlMs) {
      const lease = { key: leaseKey(name), token: uuidv4() };
      return (await resolveKv().acquire(lease.key, lease.token, ttlMs)) ? lease : null;
    },
    async releaseLease(lease) {
      await resolveKv().releaseIfHeld(lease.key, lease.token);
    },
    async lastFaucetFailure() {
      const value = await resolveKv().get(FAUCET_FAILURE_KEY);
      return value === "rate_limited" || value === "unavailable" ? value : null;
    },
    async recordFaucetFailure(failure) {
      await resolveKv().set(FAUCET_FAILURE_KEY, failure ?? "none", FAUCET_FAILURE_TTL_SECONDS);
    },
    async createBatch(memberIds) {
      const batch: PlaygroundBatch = {
        schemaVersion: BATCH_SCHEMA_VERSION,
        id: uuidv4(),
        memberIds: [...memberIds],
        createdAt: Date.now(),
      };
      if (!isPlaygroundBatch(batch))
        throw new Error("A batch needs two or three distinct sessions");
      await resolveKv().set(batchKey(batch.id), batch, SESSION_RECORD_TTL_SECONDS);
      return batch;
    },
    async loadBatch(id) {
      const value = await resolveKv().get(batchKey(id));
      return isPlaygroundBatch(value) && value.id === id ? value : null;
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

/** When the countdown of a session started at `now` ends, in epoch milliseconds. */
export function sessionExpiresAt(now: number): number {
  return now + SESSION_COUNTDOWN_SECONDS * 1000;
}

/** Whether the session's countdown has ended. */
export function isSessionExpired(
  session: Pick<PlaygroundSession, "expiresAt">,
  now: number
): boolean {
  return now >= session.expiresAt;
}
