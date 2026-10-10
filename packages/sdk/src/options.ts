import type { Network } from "@lumenwipe/types";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RetryOptions {
  /** Total attempts including the first. Values below 2 disable retrying. */
  attempts: number;
  /** Base delay for exponential backoff when the response has no `Retry-After`. */
  baseDelayMs: number;
}

export interface RequestOptions {
  /** Aborts the request. Rejects with `LumenWipeAbortError`, distinct from a timeout. */
  signal?: AbortSignal;
}

export interface LumenWipeClientOptions {
  /** Base URL of the LumenWipe API, e.g. `https://api.lumenwipe.com`. */
  baseUrl: string;
  /** Integrator API key, sent as `Authorization: Bearer <apiKey>`. */
  apiKey: string;
  /** Default network for calls that omit it. Defaults to `"testnet"`, with a one-time notice. */
  network?: Network;
  /** Custom fetch (for environments without a global `fetch`, or for testing). */
  fetch?: FetchLike;
  /** Per-request timeout in milliseconds. Defaults to 30000. `0`/`Infinity` disables it. */
  timeout?: number;
  /** Opt-in retries. Off by default; never applied to `submit` or `mediatorSign`. */
  retry?: RetryOptions;
  /** Receives one-time notices (plaintext `baseUrl`, defaulted network). Defaults to `console.warn`. */
  logger?: (message: string) => void;
}
