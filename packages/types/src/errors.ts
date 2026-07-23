/** Structured error body used by the v1 (`/v1/...`) endpoints. */
export interface StructuredApiError {
  error: { code: string; message: string; details?: unknown };
}

/** Plain error body used by the read + mediator endpoints. */
export interface PlainApiError {
  error: string;
}

export type ApiErrorBody = StructuredApiError | PlainApiError;
