import type { Network } from "@lumenwipe/types";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface LumenWipeClientOptions {
  /** Base URL of the LumenWipe API, e.g. `https://api.lumenwipe.com`. */
  baseUrl: string;
  /** Integrator API key, sent as `Authorization: Bearer <apiKey>`. */
  apiKey: string;
  /** Default network for calls that omit it. Defaults to `"testnet"`. */
  network?: Network;
  /** Custom fetch (for environments without a global `fetch`, or for testing). */
  fetch?: FetchLike;
  /** Per-request timeout in milliseconds. Defaults to 30000. `0`/`Infinity` disables it. */
  timeout?: number;
}
