import type {
  AccountState,
  AllowancesResult,
  ClosePlanRequest,
  CloseTransactionsRequest,
  FeeBumpSponsorResponse,
  HealthResponse,
  MediatorCheckResult,
  MediatorSignResponse,
  Network,
  PathResponse,
  PlanResponse,
  RevokeAllowanceResponse,
  SubmitResponse,
  TransactionsResponse,
} from "@lumenwipe/types";
import { HttpTransport } from "./http";
import type { LumenWipeClientOptions, RequestOptions } from "./options";

function isPlaintextRemote(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:") return false;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    return !(host === "localhost" || host === "::1" || /^127\./.test(host));
  } catch {
    return false;
  }
}

/**
 * Thin, typed client over the LumenWipe REST API. It only relays JSON and XDR
 * strings - transaction building and signing stay with the caller, so this
 * package has no `@stellar/stellar-sdk` dependency.
 */
export class LumenWipeClient {
  private readonly http: HttpTransport;
  private readonly defaultNetwork: Network | undefined;
  private readonly log: (message: string) => void;
  private warnedDefaultNetwork = false;

  constructor(options: LumenWipeClientOptions) {
    const resolved = options.fetch ?? globalThis.fetch;
    if (!resolved) {
      throw new Error("No fetch implementation available; pass one via options.fetch.");
    }
    this.http = new HttpTransport(
      options.baseUrl.replace(/\/+$/, ""),
      options.apiKey,
      options.timeout ?? 30_000,
      resolved,
      options.retry
    );
    this.defaultNetwork = options.network;
    this.log = options.logger ?? ((message) => console.warn(message));
    if (isPlaintextRemote(options.baseUrl)) {
      this.log(
        "LumenWipe: baseUrl uses http:// for a non-local host. The API key is sent in clear text; use https://."
      );
    }
  }

  private resolveNetwork(network: Network | undefined): Network {
    if (network) return network;
    if (this.defaultNetwork) return this.defaultNetwork;
    if (!this.warnedDefaultNetwork) {
      this.warnedDefaultNetwork = true;
      this.log(
        'LumenWipe: no network given, defaulting to "testnet". Pass `network` to the client or the call to silence this.'
      );
    }
    return "testnet";
  }

  health(options?: RequestOptions): Promise<HealthResponse> {
    return this.http.request<HealthResponse>("GET", "/health", undefined, {
      ...options,
      retry: "transient",
    });
  }

  getAccount(address: string, network?: Network, options?: RequestOptions): Promise<AccountState> {
    return this.http.request<AccountState>(
      "GET",
      `/${this.resolveNetwork(network)}/account/${encodeURIComponent(address)}`,
      undefined,
      { ...options, retry: "transient" }
    );
  }

  getPaths(
    params: { fromAsset: string; amount: string },
    network?: Network,
    options?: RequestOptions
  ): Promise<PathResponse> {
    const query = new URLSearchParams({ fromAsset: params.fromAsset, amount: params.amount });
    return this.http.request<PathResponse>(
      "GET",
      `/${this.resolveNetwork(network)}/paths?${query.toString()}`,
      undefined,
      { ...options, retry: "transient" }
    );
  }

  closePlan(
    body: ClosePlanRequest,
    network?: Network,
    options?: RequestOptions
  ): Promise<PlanResponse> {
    return this.http.request<PlanResponse>(
      "POST",
      `/v1/${this.resolveNetwork(network)}/close/plan`,
      body,
      { ...options, retry: "throttle" }
    );
  }

  /**
   * Builds the next unsigned transaction(s) for a close. A close can span several
   * transactions (a single transaction, or separate claim / cleanup / mediator-merge steps),
   * so the response's `remaining.requiresAnotherCall` says whether more follow: sign and
   * submit the returned transactions in `order`, wait for confirmation, then call this
   * again until `requiresAnotherCall` is false.
   */
  closeTransactions(
    body: CloseTransactionsRequest,
    network?: Network,
    options?: RequestOptions
  ): Promise<TransactionsResponse> {
    return this.http.request<TransactionsResponse>(
      "POST",
      `/v1/${this.resolveNetwork(network)}/close/transactions`,
      body,
      { ...options, retry: "throttle" }
    );
  }

  submit(signedXdr: string, network?: Network, options?: RequestOptions): Promise<SubmitResponse> {
    return this.http.request<SubmitResponse>(
      "POST",
      `/v1/${this.resolveNetwork(network)}/submit`,
      { signedXdr },
      { ...options, retry: "never" }
    );
  }

  mediatorCheck(
    address: string,
    network?: Network,
    options?: RequestOptions
  ): Promise<MediatorCheckResult> {
    return this.http.request<MediatorCheckResult>(
      "GET",
      `/${this.resolveNetwork(network)}/mediator/check/${encodeURIComponent(address)}`,
      undefined,
      { ...options, retry: "transient" }
    );
  }

  mediatorSign(
    transaction: string,
    network?: Network,
    options?: RequestOptions
  ): Promise<MediatorSignResponse> {
    return this.http.request<MediatorSignResponse>(
      "POST",
      `/${this.resolveNetwork(network)}/mediator/sign`,
      {
        transaction,
      },
      { ...options, retry: "never" }
    );
  }

  /** Wraps a wind-down transaction (its own fee already zero) in a signed CAP-15 fee-bump
   *  envelope for an account that cannot pay its own fee (architecture.md §8.1). The caller
   *  submits the returned XDR through `submit()`, exactly like any other close transaction. */
  feeBumpSponsor(
    transaction: string,
    network?: Network,
    options?: RequestOptions
  ): Promise<FeeBumpSponsorResponse> {
    return this.http.request<FeeBumpSponsorResponse>(
      "POST",
      `/${this.resolveNetwork(network)}/fee-bump/sponsor`,
      {
        transaction,
      },
      { ...options, retry: "throttle" }
    );
  }

  /** Every live SEP-41 allowance the account has granted (architecture.md §12). Independent of
   *  closing an account - a standalone security utility. */
  getAllowances(
    address: string,
    network?: Network,
    options?: RequestOptions
  ): Promise<AllowancesResult> {
    return this.http.request<AllowancesResult>(
      "GET",
      `/${this.resolveNetwork(network)}/allowances/${encodeURIComponent(address)}`,
      undefined,
      { ...options, retry: "transient" }
    );
  }

  /** Builds the unsigned `approve(owner, spender, 0, 0)` transaction that revokes one allowance.
   *  The caller signs and submits it through `submit()`, like any other transaction here. */
  revokeAllowance(
    params: { owner: string; token: string; spender: string },
    network?: Network,
    options?: RequestOptions
  ): Promise<RevokeAllowanceResponse> {
    return this.http.request<RevokeAllowanceResponse>(
      "POST",
      `/${this.resolveNetwork(network)}/allowances/revoke`,
      params,
      { ...options, retry: "throttle" }
    );
  }
}
