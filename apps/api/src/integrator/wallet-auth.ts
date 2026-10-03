import { createHash, createHmac, timingSafeEqual } from "crypto";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

const CHALLENGE_TTL_SECONDS = 300;
const CHALLENGE_WINDOW_SECONDS = 60;
const SESSION_TTL_SECONDS = 1800;
const SEP53_PREFIX = "Stellar Signed Message:\n";

export interface Challenge {
  message: string;
  expiresAt: string;
}

export interface Session {
  token: string;
  expiresAt: string;
}

function hmac(secret: string, label: string, ...parts: string[]): Buffer {
  return createHmac("sha256", secret)
    .update([label, ...parts].join("\n"))
    .digest();
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isClassicAddress(address: unknown): address is string {
  return typeof address === "string" && StrKey.isValidEd25519PublicKey(address);
}

function windowStart(now: Date, windowsAgo = 0): number {
  const seconds = Math.floor(now.getTime() / 1000);
  return seconds - (seconds % CHALLENGE_WINDOW_SECONDS) - windowsAgo * CHALLENGE_WINDOW_SECONDS;
}

function challengeMessage(secret: string, address: string, start: number): string {
  const nonce = hmac(secret, "challenge", address, String(start)).toString("base64url");
  return `LumenWipe API keys sign-in\nAddress: ${address}\nIssued: ${start}\nNonce: ${nonce}`;
}

/**
 * Stateless SEP-53 sign-in challenge: the nonce is an HMAC of the address and a time window, so
 * the API stores nothing and any instance can verify it. Verification rebuilds the expected
 * message from the server's clock instead of reading a timestamp out of what the caller sent.
 */
export function buildChallenge(secret: string, address: string, now: Date = new Date()): Challenge {
  const start = windowStart(now);
  return {
    message: challengeMessage(secret, address, start),
    expiresAt: new Date((start + CHALLENGE_TTL_SECONDS) * 1000).toISOString(),
  };
}

/**
 * True only if `signature` (base64) is the owner of `address` signing a still-valid challenge
 * minted by `buildChallenge`: SEP-53 is an ed25519 signature over SHA-256 of the prefixed message.
 */
export function verifyChallenge(
  secret: string,
  address: string,
  message: string,
  signature: string,
  now: Date = new Date()
): boolean {
  const windows = CHALLENGE_TTL_SECONDS / CHALLENGE_WINDOW_SECONDS;
  const received = Buffer.from(message);
  let valid = false;
  for (let ago = 0; ago < windows; ago++) {
    const expected = Buffer.from(challengeMessage(secret, address, windowStart(now, ago)));
    valid = safeEqual(received, expected) || valid;
  }
  if (!valid) return false;
  const digest = createHash("sha256").update(`${SEP53_PREFIX}${message}`).digest();
  const sig = Buffer.from(signature, "base64");
  return sig.length === 64 && Keypair.fromPublicKey(address).verify(digest, sig);
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
  if (prefix !== "lws" || rest.length > 0 || !mac || !isClassicAddress(address)) return null;
  const exp = Number(expRaw);
  if (!Number.isInteger(exp) || exp < Math.floor(now.getTime() / 1000)) return null;
  const expected = hmac(secret, "session", address, String(exp));
  return safeEqual(Buffer.from(mac, "base64url"), expected) ? address : null;
}
