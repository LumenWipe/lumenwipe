import { Keypair } from "@stellar/stellar-sdk";
import { canonicalJson } from "./canonical";

/**
 * The signature a maintainer puts on the exchange registry, and how a client decides to believe
 * it. A registry that verifies may add exchanges that need the shared intermediary; one that
 * does not verify is treated exactly as an unsigned one.
 *
 * The signed bytes are SIGNING_LABEL, a newline, then the canonical JSON of
 * `{ format, issuedAt, registry, sequence }`, where `registry` holds exactly the five fields in
 * REGISTRY_FIELDS of the served body. The label keeps the bytes from being a transaction
 * signature (those cover a 32-byte hash) or any other kind of payload.
 */

export const SIGNING_LABEL = "lumenwipe.exchange-registry.signature.v1";
export const SIGNATURE_FORMAT = 1;
export const REGISTRY_FIELDS = [
  "version",
  "lastVerified",
  "validUntil",
  "source",
  "entries",
] as const;

/** The SDK types its byte arguments as Buffer; a Uint8Array verifies the same. */
type VerifyBytes = Parameters<Keypair["verify"]>[0];

const DAY_MS = 86_400_000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const BASE64 = /^[A-Za-z0-9+/]{86}==$/;

/** The envelope served beside the registry and committed next to it. */
export interface RegistrySignature {
  format: 1;
  /** Rises by one with every signed registry; a client never accepts one below the bundled. */
  sequence: number;
  /** The day it was signed (YYYY-MM-DD, UTC). */
  issuedAt: string;
  /** Base64 of the 64-byte Ed25519 signature. */
  signature: string;
}

export type SignatureFailure =
  "malformed" | "bad-signature" | "stale-sequence" | "expired" | "future-dated";

export type SignatureVerdict =
  { ok: true; sequence: number } | { ok: false; reason: SignatureFailure };

export interface SignatureContext {
  /** Public keys (G...); a signature by any one verifies. */
  keys: readonly string[];
  /** The sequence of the registry bundled with this build. */
  bundledSequence: number;
  now: Date;
}

function isDay(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DAY.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().startsWith(value);
}

/** The envelope, or null when it is not exactly the four fields of a v1 envelope. */
export function parseSignature(raw: unknown): RegistrySignature | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const keys = Object.keys(r).sort().join(",");
  if (keys !== "format,issuedAt,sequence,signature") return null;
  if (r.format !== SIGNATURE_FORMAT) return null;
  if (typeof r.sequence !== "number" || !Number.isSafeInteger(r.sequence) || r.sequence < 1) {
    return null;
  }
  if (!isDay(r.issuedAt)) return null;
  if (typeof r.signature !== "string" || !BASE64.test(r.signature)) return null;
  return {
    format: SIGNATURE_FORMAT,
    sequence: r.sequence,
    issuedAt: r.issuedAt,
    signature: r.signature,
  };
}

/** The five signed fields of a registry body, or null when one is missing. */
export function registryProjection(body: unknown): Record<string, unknown> | null {
  if (typeof body !== "object" || body === null) return null;
  const source = body as Record<string, unknown>;
  const projection: Record<string, unknown> = {};
  for (const field of REGISTRY_FIELDS) {
    if (!(field in source)) return null;
    projection[field] = source[field];
  }
  return projection;
}

/** The exact bytes that are signed, or null when the registry cannot be written canonically. */
export function signingBytes(
  registry: unknown,
  meta: { sequence: number; issuedAt: string }
): Uint8Array | null {
  const projection = registryProjection(registry);
  if (projection === null) return null;
  try {
    const text = canonicalJson({
      format: SIGNATURE_FORMAT,
      issuedAt: meta.issuedAt,
      registry: projection,
      sequence: meta.sequence,
    });
    return new TextEncoder().encode(`${SIGNING_LABEL}\n${text}`);
  } catch {
    return null;
  }
}

function decodeSignature(encoded: string): Uint8Array | null {
  try {
    const raw = atob(encoded);
    const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    return bytes.length === 64 && btoa(raw) === encoded ? bytes : null;
  } catch {
    return null;
  }
}

function verifiesUnderAny(
  keys: readonly string[],
  bytes: Uint8Array,
  signature: Uint8Array
): boolean {
  return keys.some((key) => {
    try {
      return Keypair.fromPublicKey(key).verify(bytes as VerifyBytes, signature as VerifyBytes);
    } catch {
      return false;
    }
  });
}

/**
 * Whether `envelope` is a current signature by a trusted key over `body`. Never throws: every
 * failure is a verdict, and the caller treats each one as "not signed".
 */
export function verifyRegistrySignature(
  body: unknown,
  envelope: unknown,
  context: SignatureContext
): SignatureVerdict {
  const parsed = parseSignature(envelope);
  const bytes = parsed === null ? null : signingBytes(body, parsed);
  const signature = parsed === null ? null : decodeSignature(parsed.signature);
  if (parsed === null || bytes === null || signature === null) {
    return { ok: false, reason: "malformed" };
  }
  if (!verifiesUnderAny(context.keys, bytes, signature)) {
    return { ok: false, reason: "bad-signature" };
  }
  if (parsed.sequence < context.bundledSequence) return { ok: false, reason: "stale-sequence" };

  const { validUntil } = body as { validUntil: unknown };
  const until = typeof validUntil === "string" ? validUntil : "";
  if (!isDay(until) || Date.parse(`${until}T23:59:59Z`) < context.now.getTime()) {
    return { ok: false, reason: "expired" };
  }
  const issued = Date.parse(`${parsed.issuedAt}T00:00:00Z`);
  if (issued > context.now.getTime() + DAY_MS || parsed.issuedAt > until) {
    return { ok: false, reason: "future-dated" };
  }
  return { ok: true, sequence: parsed.sequence };
}
