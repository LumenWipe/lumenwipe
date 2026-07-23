import type {
  AccountState,
  ClosePlanRequest,
  CloseTransactionsRequest,
  HealthResponse,
  MediatorCheckResult,
  MediatorSignResponse,
  Network,
  PathResponse,
  PlanResponse,
  SubmitResponse,
  TransactionsResponse,
} from "@lumenwipe/types";

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
}

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

/**
 * Thin, typed client over the LumenWipe REST API. It only relays JSON and XDR
 * strings — transaction building and signing stay with the caller, so this
 * package has no `@stellar/stellar-sdk` dependency.
 */
export class LumenWipeClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly defaultNetwork: Network;
  private readonly doFetch: FetchLike;

  constructor(options: LumenWipeClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.defaultNetwork = options.network ?? "testnet";
    const resolved = options.fetch ?? globalThis.fetch;
    if (!resolved) {
      throw new Error("No fetch implementation available; pass one via options.fetch.");
    }
    this.doFetch = resolved;
  }

  health(): Promise<HealthResponse> {
    return this.request<HealthResponse>("GET", "/health");
  }

  getAccount(address: string, network: Network = this.defaultNetwork): Promise<AccountState> {
    return this.request<AccountState>("GET", `/${network}/account/${encodeURIComponent(address)}`);
  }

  getPaths(
    params: { fromAsset: string; amount: string },
    network: Network = this.defaultNetwork
  ): Promise<PathResponse> {
    const query = new URLSearchParams({ fromAsset: params.fromAsset, amount: params.amount });
    return this.request<PathResponse>("GET", `/${network}/paths?${query.toString()}`);
  }

  closePlan(body: ClosePlanRequest, network: Network = this.defaultNetwork): Promise<PlanResponse> {
    return this.request<PlanResponse>("POST", `/v1/${network}/close/plan`, body);
  }

  closeTransactions(
    body: CloseTransactionsRequest,
    network: Network = this.defaultNetwork
  ): Promise<TransactionsResponse> {
    return this.request<TransactionsResponse>("POST", `/v1/${network}/close/transactions`, body);
  }

  submit(signedXdr: string, network: Network = this.defaultNetwork): Promise<SubmitResponse> {
    return this.request<SubmitResponse>("POST", `/v1/${network}/submit`, { signedXdr });
  }

  mediatorCheck(
    address: string,
    network: Network = this.defaultNetwork
  ): Promise<MediatorCheckResult> {
    return this.request<MediatorCheckResult>(
      "GET",
      `/${network}/mediator/check/${encodeURIComponent(address)}`
    );
  }

  mediatorSign(
    transaction: string,
    network: Network = this.defaultNetwork
  ): Promise<MediatorSignResponse> {
    return this.request<MediatorSignResponse>("POST", `/${network}/mediator/sign`, { transaction });
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const res = await this.doFetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      // A proxy/CDN can return a non-JSON error body (e.g. an HTML 502). Fall
      // back to the raw text so a non-2xx always surfaces as a LumenWipeApiError
      // with its status, never a raw SyntaxError.
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) throw new LumenWipeApiError(res.status, parsed);
    return parsed as T;
  }
}

export type * from "@lumenwipe/types";
