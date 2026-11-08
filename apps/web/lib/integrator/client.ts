import type {
  CreateIntegratorKeyRequest,
  IntegratorKeyList,
  IntegratorKeyListEntry,
  IntegratorKeyRecord,
  IntegratorKeyUsage,
  IntegratorOwnerUsage,
  IssuedIntegratorKey,
} from "@lumenwipe/types";

/** The API's own shapes, so the page and the SDK read the same fields. */
export type KeyRecord = IntegratorKeyRecord;
export type KeyListEntry = IntegratorKeyListEntry;
export type KeyUsage = IntegratorKeyUsage;
export type Usage = IntegratorOwnerUsage;
export type KeyList = IntegratorKeyList;
export type CreatedKey = IssuedIntegratorKey;
export type CreateKeyRequest = CreateIntegratorKeyRequest;

/** The signed-in wallet. The session token itself lives in an httpOnly cookie and never reaches
 *  this code. */
export interface Session {
  address: string;
  expiresAt: string;
}

export class IntegratorRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null
  ) {
    super(message);
  }
}

function messageFrom(payload: unknown, status: number): string {
  if (typeof payload === "object" && payload !== null && "error" in payload) {
    const error = (payload as { error: unknown }).error;
    if (typeof error === "string") return error;
    if (typeof error === "object" && error !== null && "message" in error) {
      const message = (error as { message: unknown }).message;
      if (typeof message === "string") return message;
    }
  }
  return status === 401
    ? "Your session expired. Sign in again."
    : "Something went wrong. Please try again.";
}

function codeFrom(payload: unknown): string | null {
  const error = (payload as { error?: { code?: unknown } } | null)?.error;
  return typeof error === "object" && error !== null && typeof error.code === "string"
    ? error.code
    : null;
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/integrator/${path}`, {
      ...init,
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new IntegratorRequestError("Could not reach LumenWipe. Check your connection.", 0);
  }
  if (res.status === 204) return undefined as T;
  const payload: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    throw new IntegratorRequestError(
      messageFrom(payload, res.status),
      res.status,
      codeFrom(payload)
    );
  }
  return payload as T;
}

export function requestChallenge(address: string): Promise<{ message: string }> {
  return request("auth/challenge", { method: "POST", body: JSON.stringify({ address }) });
}

export function createSession(
  address: string,
  message: string,
  signature: string
): Promise<Session> {
  return request("auth/session", {
    method: "POST",
    body: JSON.stringify({ address, message, signature }),
  });
}

/** The session this browser holds, restored from its cookie; rejects with 401 when there is none. */
export function getSession(): Promise<Session> {
  return request("auth/session", { method: "GET" });
}

export function endSession(): Promise<void> {
  return request("auth/session", { method: "DELETE" });
}

export function listKeys(): Promise<KeyList> {
  return request("keys", { method: "GET" });
}

/** An omitted label or scope is left out of the body: no label, every network. */
export function createKey(options: CreateKeyRequest = {}): Promise<CreatedKey> {
  return request("keys", { method: "POST", body: JSON.stringify(options) });
}

export function revokeKey(id: string): Promise<{ status: string }> {
  return request(`keys/${encodeURIComponent(id)}/revoke`, { method: "POST" });
}

export function rotateKey(id: string): Promise<CreatedKey> {
  return request(`keys/${encodeURIComponent(id)}/rotate`, { method: "POST" });
}
