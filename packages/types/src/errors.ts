/** Structured error body used by the v1 (`/v1/...`) endpoints. */
export interface StructuredApiError {
  error: { code: string; message: string; details?: unknown };
}

/** @deprecated The API emits one envelope (`StructuredApiError`). Kept only so a consumer
 *  pinned to an older deployment still type-checks during a rollout; remove once none remain. */
export interface PlainApiError {
  error: string;
}

export type ApiErrorBody = StructuredApiError | PlainApiError;
