import type {
  CreateIntegratorKeyRequest,
  IntegratorChallengeResponse,
  IntegratorKeyList,
  IntegratorSessionRequest,
  IntegratorSessionResponse,
  IssuedIntegratorKey,
  RevokedIntegratorKey,
} from "@lumenwipe/types";
import { isPlaintextRemote } from "./client";
import { HttpTransport } from "./http";
import { withoutTrailingSlashes } from "./url";
import type { LumenWipeIntegratorClientOptions, RequestOptions } from "./options";

/**
 * Wallet-authenticated self-service API key management, kept apart from `LumenWipeClient` so the
 * main client stays small. It takes no API key and never sends one: the challenge and session
 * calls carry no `Authorization`, and the key calls carry only the session token passed to them.
 *
 * Sign in by signing the `challenge(address)` message with the wallet (SEP-53) and exchanging it
 * through `session(...)` for a token valid for 30 minutes. Every key belongs to that wallet.
 */
export class LumenWipeIntegratorClient {
  private readonly http: HttpTransport;

  constructor(options: LumenWipeIntegratorClientOptions) {
    const resolved = options.fetch ?? globalThis.fetch;
    if (!resolved) {
      throw new Error("No fetch implementation available; pass one via options.fetch.");
    }
    this.http = new HttpTransport(
      withoutTrailingSlashes(options.baseUrl),
      undefined,
      options.timeout ?? 30_000,
      resolved,
      options.retry
    );
    if (isPlaintextRemote(options.baseUrl)) {
      (options.logger ?? ((message) => console.warn(message)))(
        "LumenWipe: baseUrl uses http:// for a non-local host. Session tokens and new keys travel in clear text; use https://."
      );
    }
  }

  /** A SEP-53 message for `address` (G...) to sign, valid until `expiresAt`. */
  challenge(address: string, options?: RequestOptions): Promise<IntegratorChallengeResponse> {
    return this.http.request<IntegratorChallengeResponse>(
      "POST",
      "/v1/integrator/auth/challenge",
      { address },
      { ...options, retry: "throttle" }
    );
  }

  /** Exchanges the signed challenge for a session token. */
  session(
    request: IntegratorSessionRequest,
    options?: RequestOptions
  ): Promise<IntegratorSessionResponse> {
    return this.http.request<IntegratorSessionResponse>(
      "POST",
      "/v1/integrator/auth/session",
      { address: request.address, message: request.message, signature: request.signature },
      { ...options, retry: "throttle" }
    );
  }

  /** The wallet's keys, each with its own request counts, and the wallet's total counts. */
  listKeys(token: string, options?: RequestOptions): Promise<IntegratorKeyList> {
    return this.http.request<IntegratorKeyList>("GET", "/v1/integrator/keys", undefined, {
      ...options,
      retry: "transient",
      bearer: token,
    });
  }

  /** Creates a key, optionally named and limited to some networks. The raw `key` is in this
   *  response only and can never be read again. */
  createKey(
    token: string,
    request: CreateIntegratorKeyRequest = {},
    options?: RequestOptions
  ): Promise<IssuedIntegratorKey> {
    return this.http.request<IssuedIntegratorKey>(
      "POST",
      "/v1/integrator/keys",
      { label: request.label, networks: request.networks },
      { ...options, retry: "never", bearer: token }
    );
  }

  /** Revokes one of the wallet's keys by its `id`. */
  revokeKey(token: string, id: string, options?: RequestOptions): Promise<RevokedIntegratorKey> {
    return this.http.request<RevokedIntegratorKey>(
      "POST",
      `/v1/integrator/keys/${encodeURIComponent(id)}/revoke`,
      undefined,
      { ...options, retry: "never", bearer: token }
    );
  }

  /** Revokes a key and issues its replacement, keeping its label and networks. The new raw `key`
   *  is in this response only. */
  rotateKey(token: string, id: string, options?: RequestOptions): Promise<IssuedIntegratorKey> {
    return this.http.request<IssuedIntegratorKey>(
      "POST",
      `/v1/integrator/keys/${encodeURIComponent(id)}/rotate`,
      undefined,
      { ...options, retry: "never", bearer: token }
    );
  }
}
