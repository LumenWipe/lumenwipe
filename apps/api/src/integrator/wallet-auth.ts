import { createHash, createHmac, timingSafeEqual } from "crypto";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

const CHALLENGE_TTL_SECONDS = 300;
const SESSION_TTL_SECONDS = 1800;
const SEP53_PREFIX = "Stellar Signed Message:\n";
const MESSAGE_PATTERN =
  /^LumenWipe API keys sign-in\nAddress: (G[A-Z2-7]{55})\nExpires: (\d+)\nNonce: ([A-Za-z0-9_-]+)$/;

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

function challengeNonce(secret: string, address: string, expires: number): string {
  return hmac(secret, "challenge", address, String(expires)).toString("base64url");
}

export function isClassicAddress(address: unknown): address is string {
  return typeof address === "string" && StrKey.isValidEd25519PublicKey(address);
}

/**
 * Stateless SEP-53 sign-in challenge: the nonce is an HMAC of the address and expiry, so the API
 * stores nothing and any instance can verify it.
 */
export function buildChallenge(secret: string, address: string, now: Date = new Date()): Challenge {
  const expires = Math.floor(now.getTime() / 1000) + CHALLENGE_TTL_SECONDS;
  const nonce = challengeNonce(secret, address, expires);
  return {
    message: `LumenWipe API keys sign-in\nAddress: ${address}\nExpires: ${expires}\nNonce: ${nonce}`,
    expiresAt: new Date(expires * 1000).toISOString(),
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
  const match = MESSAGE_PATTERN.exec(message);
  if (!match || match[1] !== address) return false;
  const expires = Number(match[2]);
  if (expires < Math.floor(now.getTime() / 1000)) return false;
  if (!safeEqual(Buffer.from(match[3]), Buffer.from(challengeNonce(secret, address, expires)))) {
    return false;
  }
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
