import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { Keypair } from "@stellar/stellar-sdk";
import { PlaygroundConfigError } from "./crypto";
import {
  DEFAULT_CUSTOM_CONFIG,
  MAX_CUSTOM_DATA_ENTRIES,
  MAX_CUSTOM_TRUSTLINES,
  type PlaygroundCustomConfig,
  type PlaygroundMode,
  maxOfferCount,
  selectionForMode,
} from "./mess-plan";
import {
  LWDEMO_CODE,
  isMessStepId,
  parseSelection,
  validateSelection,
  type MessStepDef,
  type ValidationResult,
} from "./scenarios";
import type { MessContext } from "./mess-builders";
import type { DemolishRoundResult, RunDemolishOptions } from "./demolish";
import { CREDENTIALS_PER_DAY_PER_IP, SESSIONS_PER_DAY_PER_IP, type RateLimit } from "./rate-limit";
import { actionResponse, loadSessionOrErrorResponse, notConfiguredResponse } from "./route-helpers";
import {
  readSessionState,
  runCleanup,
  runDemolishRound,
  runMessStep,
  type StateDeps,
} from "./session-actions";
import {
  PlaygroundStoreUnavailableError,
  sessionExpiresAt,
  type SessionStore,
} from "./session-store";
import { expectationFromSession } from "./verify";

// The playground's route handlers, with every side effect injected. Each app/api route file wires
// the production dependencies and calls one of these, so the request parsing, status mapping and
// ordering below are exercised by tests/unit/route-handlers.test.ts against a fake store and fake
// network clients. Route files themselves can only export Next's route fields, so this logic
// cannot live there and stay testable.

/** The server-held keys, read from the environment on each request. */
export interface PlaygroundKeys {
  issuer: () => Keypair | null;
  mm: () => Keypair | null;
}

export interface ApiConfig {
  apiUrl: string | undefined;
  apiKey: string | undefined;
}

export interface CreateSessionDeps extends PlaygroundKeys {
  store: SessionStore;
  rateLimit: RateLimit;
  /** Funds a new testnet account; false when Friendbot refused or could not be reached. */
  fundAccount: (publicKey: string) => Promise<boolean>;
  ensureMmOffer: (mm: Keypair, issuerPublic: string) => Promise<void>;
  encrypt: (secret: string) => string;
}

export interface MessDeps extends PlaygroundKeys {
  store: SessionStore;
  decrypt: (payload: string) => string;
  executeMessStep: (step: MessStepDef, ctx: MessContext) => Promise<string>;
}

export interface DemolishRouteDeps extends PlaygroundKeys {
  store: SessionStore;
  api: () => ApiConfig;
  decrypt: (payload: string) => string;
  /** Runs one round of the close (lib/demolish.ts `runDemolish`). */
  runDemolish: (opts: RunDemolishOptions) => Promise<DemolishRoundResult>;
}

export interface CleanupRouteDeps {
  store: SessionStore;
  mm: () => Keypair | null;
  decrypt: (payload: string) => string;
  /** Merges `source` into `destination` on chain. */
  merge: (source: Keypair, destination: string) => Promise<unknown>;
}

export interface CredentialsDeps {
  store: SessionStore;
  rateLimit: RateLimit;
  decrypt: (payload: string) => string;
}

export interface StateRouteDeps {
  store: SessionStore;
  api: () => ApiConfig;
  /** The account reader for a configured API. */
  accountReader: (apiUrl: string, apiKey: string) => StateDeps["getAccount"];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const clamp = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === "number" ? Math.max(min, Math.min(max, value)) : fallback;

function parseMode(value: unknown): PlaygroundMode {
  return value === "light" || value === "full" || value === "custom" ? value : "standard";
}

/** The original size modes; out-of-range custom values are clamped as they always were. */
function legacyCustomConfig(raw: unknown): PlaygroundCustomConfig {
  if (!isRecord(raw)) return DEFAULT_CUSTOM_CONFIG;
  const trustlineCount = clamp(
    raw.trustlineCount,
    1,
    MAX_CUSTOM_TRUSTLINES,
    DEFAULT_CUSTOM_CONFIG.trustlineCount
  );
  const maxOffers = maxOfferCount(trustlineCount);
  return {
    trustlineCount,
    offerCount: clamp(
      raw.offerCount,
      0,
      maxOffers,
      Math.min(DEFAULT_CUSTOM_CONFIG.offerCount, maxOffers)
    ),
    dataEntryCount: clamp(
      raw.dataEntryCount,
      0,
      MAX_CUSTOM_DATA_ENTRIES,
      DEFAULT_CUSTOM_CONFIG.dataEntryCount
    ),
    addSigner: typeof raw.addSigner === "boolean" ? raw.addSigner : DEFAULT_CUSTOM_CONFIG.addSigner,
  };
}

/**
 * Reads the scenario selection from a create request and validates it. A body with `selection`
 * must be a valid one; a body without it is read as one of the original modes.
 */
export function parseCreateBody(body: unknown): ValidationResult {
  if (isRecord(body) && body.selection !== undefined) {
    const selection = parseSelection(body.selection);
    if (!selection) return { ok: false, message: "The scenario selection could not be read." };
    return validateSelection(selection);
  }
  const mode = isRecord(body) ? parseMode(body.mode) : "standard";
  const custom =
    mode === "custom" && isRecord(body)
      ? legacyCustomConfig(body.customConfig)
      : DEFAULT_CUSTOM_CONFIG;
  return validateSelection(selectionForMode(mode, custom));
}

export async function handleCreateSession(
  req: NextRequest,
  deps: CreateSessionDeps
): Promise<NextResponse> {
  // Each session Friendbot-funds a fresh testnet account, spawns ephemeral issuers, and writes
  // a custodial session to KV. Anonymous and unbounded, that is an open faucet drain.
  const limited = await deps.rateLimit(req, "session", SESSIONS_PER_DAY_PER_IP);
  if (limited) return limited;

  const issuer = deps.issuer();
  const mm = deps.mm();
  if (!issuer || !mm) {
    return notConfiguredResponse();
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    // Malformed or absent body - use defaults.
    body = undefined;
  }
  const parsed = parseCreateBody(body);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: "invalid_selection", message: parsed.message },
      { status: 400 }
    );
  }
  const { plan } = parsed;

  // Keys are always fresh randomness, never derived from anything in the request.
  const demo = Keypair.random();
  const ephemeral = plan.ephemeralAssets.map((code) => ({
    assetCode: code,
    keypair: Keypair.random(),
  }));

  if (!(await deps.fundAccount(demo.publicKey()))) {
    return NextResponse.json({ error: "friendbot_failed" }, { status: 502 });
  }

  try {
    await deps.ensureMmOffer(mm, issuer.publicKey());
  } catch (err) {
    console.error("[playground] MM offer self-healing failed:", err);
  }

  try {
    const session = await deps.store.createSession({
      demoPublic: demo.publicKey(),
      encDemoSecret: deps.encrypt(demo.secret()),
      ephemeralIssuers: ephemeral.map((e) => ({
        publicKey: e.keypair.publicKey(),
        encSecret: deps.encrypt(e.keypair.secret()),
        assetCode: e.assetCode,
      })),
      completedMessSteps: [],
      recordedSigners: [],
      demolishLog: [],
      demolishPending: null,
      demolishDone: false,
      selection: plan.selection,
    });

    return NextResponse.json({
      sessionId: session.id,
      demoPublic: session.demoPublic,
      expiresAt: sessionExpiresAt(),
      messPlan: plan.steps,
      accounts: {
        issuer: issuer.publicKey(),
        mm: mm.publicKey(),
        lwdemoAsset: `${LWDEMO_CODE}:${issuer.publicKey()}`,
        ephemeral: ephemeral.map((e) => ({ code: e.assetCode, publicKey: e.keypair.publicKey() })),
      },
    });
  } catch (err) {
    if (err instanceof PlaygroundConfigError || err instanceof PlaygroundStoreUnavailableError) {
      return notConfiguredResponse();
    }
    throw err;
  }
}

export async function handleMess(
  req: NextRequest,
  id: string,
  deps: MessDeps
): Promise<NextResponse> {
  let stepId: unknown;
  try {
    const body: unknown = await req.json();
    if (body === null || typeof body !== "object") {
      throw new Error("invalid body");
    }
    stepId = "stepId" in body ? body.stepId : undefined;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (typeof stepId !== "string" || !isMessStepId(stepId)) {
    return NextResponse.json({ error: "invalid_step" }, { status: 400 });
  }

  const issuer = deps.issuer();
  const mm = deps.mm();
  if (!issuer || !mm) return notConfiguredResponse();

  const result = await runMessStep(deps.store, id, stepId, {
    executeStep: (step, session, recordSigner) =>
      deps.executeMessStep(step, {
        demo: Keypair.fromSecret(deps.decrypt(session.encDemoSecret)),
        ephemeralIssuers: new Map(
          session.ephemeralIssuers.map((e) => [
            e.assetCode,
            Keypair.fromSecret(deps.decrypt(e.encSecret)),
          ])
        ),
        persistentIssuer: issuer,
        mmPublic: mm.publicKey(),
        recordSigner,
      }),
  });
  return actionResponse(result);
}

/**
 * Runs one round of the close. The client calls again while `done` is false, and after a failure
 * (the resume); each call takes the session lock for its own round only.
 */
export async function handleDemolishRound(
  id: string,
  deps: DemolishRouteDeps
): Promise<NextResponse> {
  const mm = deps.mm();
  const issuer = deps.issuer();
  const { apiUrl, apiKey } = deps.api();
  if (!mm || !issuer || !apiUrl || !apiKey) return notConfiguredResponse();

  const result = await runDemolishRound(deps.store, id, {
    // The expectation is derived from the session as this round's lock read it.
    round: (session, hooks) =>
      deps.runDemolish({
        demoKeypair: Keypair.fromSecret(deps.decrypt(session.encDemoSecret)),
        expected: expectationFromSession(session, mm.publicKey(), issuer.publicKey()),
        apiUrl,
        apiKey,
        hooks,
      }),
  });
  return actionResponse(result);
}

/**
 * Recycles the ephemeral issuer accounts (merges their ~3 XLM back into the market maker) and
 * deletes the session. Best-effort: failures are logged but never block the caller - the XLM
 * involved is testnet-only.
 */
export async function handleCleanup(id: string, deps: CleanupRouteDeps): Promise<NextResponse> {
  const mm = deps.mm();

  const result = await runCleanup(deps.store, id, {
    recycle: async (session) => {
      const recycled: string[] = [];
      if (!mm) return recycled;
      for (const eph of session.ephemeralIssuers) {
        try {
          const kp = Keypair.fromSecret(deps.decrypt(eph.encSecret));
          await deps.merge(kp, mm.publicKey());
          recycled.push(eph.publicKey);
        } catch (err) {
          console.error("[playground] cleanup merge failed", { issuer: eph.publicKey }, err);
        }
      }
      return recycled;
    },
  });
  return actionResponse(result);
}

export async function handleCredentials(
  req: NextRequest,
  id: string,
  deps: CredentialsDeps
): Promise<NextResponse> {
  // This route decrypts and hands back a secret key; unbounded, it is a free oracle over every
  // session id an attacker can guess or scrape.
  const limited = await deps.rateLimit(req, "credentials", CREDENTIALS_PER_DAY_PER_IP);
  if (limited) return limited;

  const session = await loadSessionOrErrorResponse(deps.store, id);
  if (session instanceof NextResponse) return session;

  try {
    const secretKey = deps.decrypt(session.encDemoSecret);
    return NextResponse.json({ publicKey: session.demoPublic, secretKey });
  } catch (err) {
    if (err instanceof PlaygroundConfigError) {
      return notConfiguredResponse();
    }
    throw err;
  }
}

export async function handleState(id: string, deps: StateRouteDeps): Promise<NextResponse> {
  const session = await loadSessionOrErrorResponse(deps.store, id);
  if (session instanceof NextResponse) return session;

  const { apiUrl, apiKey } = deps.api();
  if (!apiUrl || !apiKey) return notConfiguredResponse();

  return actionResponse(
    await readSessionState(session, { getAccount: deps.accountReader(apiUrl, apiKey) })
  );
}
