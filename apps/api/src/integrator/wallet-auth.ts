import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

const CHALLENGE_TTL_SECONDS = 300;
const CHALLENGE_WINDOW_SECONDS = 60;
const SESSION_TTL_SECONDS = 1800;
const SEP53_PREFIX = "Stellar Signed Message:\n";
const SALT_BYTES = 16;
const NONCE_LINE = /\nNonce: ([A-Za-z0-9_-]{22})\.[A-Za-z0-9_-]{43}$/;

export interface Challenge {
  message: string;
  expiresAt: string;
}

export interface Session {
  token: string;
  expiresAt: string;
}

export function hmac(secret: string, label: string, ...parts: string[]): Buffer {
  return createHmac("sha256", secret)
    .update([label, ...parts].join("\n"))
    .digest();
}

export function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isClassicAddress(address: unknown): address is string {
  return typeof address === "string" && StrKey.isValidEd25519PublicKey(address);
}

export function isContractAddress(address: unknown): address is string {
  return typeof address === "string" && StrKey.isValidContract(address);
}

/** A session can be issued to a classic account or to a contract account, never anything else. */
function isSessionOwner(address: unknown): address is string {
  return isClassicAddress(address) || isContractAddress(address);
}

function windowStart(now: Date, windowsAgo = 0): number {
  const seconds = Math.floor(now.getTime() / 1000);
  return seconds - (seconds % CHALLENGE_WINDOW_SECONDS) - windowsAgo * CHALLENGE_WINDOW_SECONDS;
}

function challengeMessage(secret: string, address: string, start: number, salt: string): string {
  const mac = hmac(secret, "challenge", address, String(start), salt).toString("base64url");
  return `LumenWipe API keys sign-in\nAddress: ${address}\nIssued: ${start}\nNonce: ${salt}.${mac}`;
}

/**
 * SEP-53 sign-in challenge: the nonce is a random salt and an HMAC of the address, a time window
 * and that salt, so any instance can verify it without storing it, and no two challenges are the
 * same. Verification rebuilds the expected message from the server's clock instead of reading a
 * timestamp out of what the caller sent; only the salt is taken from the message.
 */
export function buildChallenge(secret: string, address: string, now: Date = new Date()): Challenge {
  const start = windowStart(now);
  const salt = randomBytes(SALT_BYTES).toString("base64url");
  return {
    message: challengeMessage(secret, address, start, salt),
    expiresAt: new Date((start + CHALLENGE_TTL_SECONDS) * 1000).toISOString(),
  };
}

/**
 * When the challenge expires, if `signature` (base64) is the owner of `address` signing a
 * still-valid challenge minted by `buildChallenge`; null otherwise. SEP-53 is an ed25519 signature
 * over SHA-256 of the prefixed message.
 */
export function verifyChallenge(
  secret: string,
  address: string,
  message: string,
  signature: string,
  now: Date = new Date()
): Date | null {
  const salt = NONCE_LINE.exec(message)?.[1];
  if (!salt) return null;
  const windows = CHALLENGE_TTL_SECONDS / CHALLENGE_WINDOW_SECONDS;
  const received = Buffer.from(message);
  let issued: number | null = null;
  for (let ago = 0; ago < windows; ago++) {
    const start = windowStart(now, ago);
    const expected = Buffer.from(challengeMessage(secret, address, start, salt));
    if (safeEqual(received, expected)) issued = start;
  }
  if (issued === null) return null;
  const digest = createHash("sha256").update(`${SEP53_PREFIX}${message}`).digest();
  try {
    if (!Keypair.fromPublicKey(address).verify(digest, Buffer.from(signature, "base64"))) {
      return null;
    }
  } catch {
    return null;
  }
  return new Date((issued + CHALLENGE_TTL_SECONDS) * 1000);
}

export function issueSession(secret: string, address: string, now: Date = new Date()): Session {
  const exp = Math.floor(now.getTime() / 1000) + SESSION_TTL_SECONDS;
  const mac = hmac(secret, "session", address, String(exp)).toString("base64url");
  return { token: `lws.${address}.${exp}.${mac}`, expiresAt: new Date(exp * 1000).toISOString() };
}

/** The address a session token was issued to, or null if it is malformed, forged, or expired. */
export function verifySession(
  secret: string,
  token: string,
  now: Date = new Date()
): string | null {
  const [prefix, address, expRaw, mac, ...rest] = token.split(".");
  if (prefix !== "lws" || rest.length > 0 || !mac || !isSessionOwner(address)) return null;
  const exp = Number(expRaw);
  if (!Number.isInteger(exp) || exp < Math.floor(now.getTime() / 1000)) return null;
  const expected = hmac(secret, "session", address, String(exp));
  return safeEqual(Buffer.from(mac, "base64url"), expected) ? address : null;
}
