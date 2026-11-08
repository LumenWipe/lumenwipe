import type { Network } from "./network";

/** Response from `POST /v1/integrator/auth/challenge`: a SEP-53 message for the wallet to sign. */
export interface IntegratorChallengeResponse {
  message: string;
  /** ISO 8601 time after which the challenge is rejected. */
  expiresAt: string;
}

/** Body for `POST /v1/integrator/auth/session`. */
export interface IntegratorSessionRequest {
  /** The Stellar account (G...) that signed the challenge. */
  address: string;
  /** The challenge message exactly as returned by the challenge call. */
  message: string;
  /** Base64 ed25519 signature over the SEP-53 digest of the message. */
  signature: string;
}

/** Response from `POST /v1/integrator/auth/session`. */
export interface IntegratorSessionResponse {
  /** Bearer token for the key-management endpoints. */
  token: string;
  /** ISO 8601 time after which the token is rejected, 30 minutes after issue. */
  expiresAt: string;
}

/** Body for `POST /v1/integrator/keys`. Both fields are optional. */
export interface CreateIntegratorKeyRequest {
  /** A name for the key, 1 to 64 printable characters after trimming. */
  label?: string;
  /** The networks the key may call, at least one. Omit for every network. A scoped key is refused
   *  on routes without a network. */
  networks?: Network[];
}

/** An API key as the integrator routes describe it. Never carries the raw secret. */
export interface IntegratorKeyRecord {
  /** The key's id (the SHA-256 hash of the secret). */
  id: string;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601, or null while the key is active. */
  revokedAt: string | null;
  /** The previous key's id, if this key replaced one. */
  rotatedFrom: string | null;
  label: string | null;
  /** The networks the key may call, or null for every network. */
  networks: Network[] | null;
  /** ISO 8601 time the key last authenticated a request, or null. Written at most once a minute. */
  lastUsedAt: string | null;
}

/** One key's request counts. `rateLimitedLast30Days` counts 429s and is not part of the others. */
export interface IntegratorKeyUsage {
  today: number;
  last30Days: number;
  rateLimitedLast30Days: number;
}

/** A wallet's request counts, shared by all its keys. */
export interface IntegratorOwnerUsage {
  today: number;
  last30Days: number;
}

/** One entry of `GET /v1/integrator/keys`. `usage` is null when the counts are unavailable. */
export interface IntegratorKeyListEntry extends IntegratorKeyRecord {
  usage: IntegratorKeyUsage | null;
}

/** Response from `GET /v1/integrator/keys`. `usage` is null when the counts are unavailable. */
export interface IntegratorKeyList {
  keys: IntegratorKeyListEntry[];
  usage: IntegratorOwnerUsage | null;
}

/** Response from `POST /v1/integrator/keys` and `POST /v1/integrator/keys/{id}/rotate`. `key` is
 *  the raw secret, returned exactly once and never retrievable again. */
export interface IssuedIntegratorKey {
  key: string;
  record: IntegratorKeyRecord;
}

/** Response from `POST /v1/integrator/keys/{id}/revoke`. */
export interface RevokedIntegratorKey {
  status: "revoked";
}
