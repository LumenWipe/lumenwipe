/** Thrown when the API responds with a non-2xx status. `body` is the parsed error payload. */
export class LumenWipeApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown
  ) {
    super(`LumenWipe API error ${status}`);
    this.name = "LumenWipeApiError";
  }
}

/** Thrown when a request exceeds the configured timeout. */
export class LumenWipeTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`LumenWipe API request timed out after ${timeoutMs}ms`);
    this.name = "LumenWipeTimeoutError";
  }
}
