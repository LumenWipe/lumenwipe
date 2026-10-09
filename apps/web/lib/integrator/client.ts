export interface KeyRecord {
  id: string;
  createdAt: string;
  revokedAt: string | null;
  rotatedFrom: string | null;
}

export interface Session {
  token: string;
  expiresAt: string;
}

export interface Usage {
  today: number;
  last30Days: number;
}

export interface KeyList {
  keys: KeyRecord[];
  /** Null or absent when the API could not read it; the listing still renders without it. */
  usage?: Usage | null;
}

export interface CreatedKey {
  key: string;
  record: KeyRecord;
}

export class IntegratorRequestError extends Error {
  constructor(
    message: string,
    readonly status: number
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

async function request<T>(path: string, init: RequestInit, token?: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/integrator/${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      cache: "no-store",
    });
  } catch {
    throw new IntegratorRequestError("Could not reach LumenWipe. Check your connection.", 0);
  }
  const payload: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new IntegratorRequestError(messageFrom(payload, res.status), res.status);
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

export function listKeys(token: string): Promise<KeyList> {
  return request("keys", { method: "GET" }, token);
}

export function createKey(token: string): Promise<CreatedKey> {
  return request("keys", { method: "POST" }, token);
}

export function revokeKey(token: string, id: string): Promise<{ status: string }> {
  return request(`keys/${encodeURIComponent(id)}/revoke`, { method: "POST" }, token);
}

export function rotateKey(token: string, id: string): Promise<CreatedKey> {
  return request(`keys/${encodeURIComponent(id)}/rotate`, { method: "POST" }, token);
}
