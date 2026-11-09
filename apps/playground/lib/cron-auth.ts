import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

/** Vercel's guidance for CRON_SECRET is a random string of at least 16 characters. */
const MIN_CRON_SECRET_LENGTH = 16;

export function isCronSecretConfigured(secret: string | undefined): secret is string {
  return typeof secret === "string" && secret.length >= MIN_CRON_SECRET_LENGTH;
}

const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

/**
 * Whether the request carries `Authorization: Bearer <CRON_SECRET>`, as Vercel's cron sends it.
 * False when the secret is missing or too short. Both sides are hashed first, so the comparison
 * takes the same time whatever the header holds, its length included.
 */
export function isCronAuthorized(header: string | null, secret: string | undefined): boolean {
  if (!isCronSecretConfigured(secret) || header === null) return false;
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}
