import { createHmac, randomBytes } from "crypto";
import { isCexAddress } from "@/lib/exchange-registry";

const SECRET = /(?<![A-Z2-7])S[A-Z2-7]{55}(?![A-Z2-7])/g;
const ADDRESS = /(?<![A-Z2-7])(?:M[A-Z2-7]{68}|[GC][A-Z2-7]{55})(?![A-Z2-7])/g;
const BEARER = /Bearer\s+\S+/gi;
const BLOB = /[A-Za-z0-9+/]{100,}={0,2}/g;

const MIN_LITERAL_LENGTH = 3;

const hashKey = process.env.LOG_HASH_KEY || randomBytes(32).toString("hex");

function correlationHash(address: string): string {
  return createHmac("sha256", hashKey).update(address).digest("hex").slice(0, 8);
}

function redactAddress(address: string): string {
  if (isCexAddress(address)) return "[exchange]";
  return `${address.slice(0, 4)}...${address.slice(-4)}~${correlationHash(address)}`;
}

/**
 * The log privacy policy (docs/reference/logging-and-privacy.mdx), applied to the text of every
 * value the logger writes: whatever a call site interpolates, no secret-shaped string, full
 * address, token or XDR-sized blob leaves the process. `literals` are values the request itself
 * carried that must never appear, such as a deposit memo.
 *
 * It runs on values before they are serialized, never on the JSON line: a user-chosen memo such
 * as `","` or `severity` would otherwise rewrite the line's own structure.
 */
export function scrubText(text: string, literals: Iterable<string> = []): string {
  let out = text;
  for (const literal of literals) {
    if (literal.length >= MIN_LITERAL_LENGTH) out = out.split(literal).join("[memo]");
  }
  return out
    .replace(SECRET, "[redacted-secret]")
    .replace(BEARER, "Bearer [redacted]")
    .replace(ADDRESS, redactAddress)
    .replace(BLOB, "[redacted]");
}

/** `scrubText` over every string in a JSON-shaped value; object keys are left alone. */
export function scrubValue(value: unknown, literals: readonly string[]): unknown {
  if (typeof value === "string") return scrubText(value, literals);
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, literals));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, scrubValue(inner, literals)])
    );
  }
  return value;
}
