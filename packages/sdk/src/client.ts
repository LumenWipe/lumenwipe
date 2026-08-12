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
import { HttpTransport } from "./http";
import type { LumenWipeClientOptions } from "./options";

/**
 * Thin, typed client over the LumenWipe REST API. It only relays JSON and XDR
 * strings - transaction building and signing stay with the caller, so this
 * package has no `@stellar/stellar-sdk` dependency.
 */
export class LumenWipeClient {
  private readonly http: HttpTransport;
  private readonly defaultNetwork: Network;

  constructor(options: LumenWipeClientOptions) {
    const resolved = options.fetch ?? globalThis.fetch;
    if (!resolved) {
      throw new Error("No fetch implementation available; pass one via options.fetch.");
    }
    this.http = new HttpTransport(
      options.baseUrl.replace(/\/+$/, ""),
      options.apiKey,
      options.timeout ?? 30_000,
      resolved
    );
    this.defaultNetwork = options.network ?? "testnet";
  }

  health(): Promise<HealthResponse> {
    return this.http.request<HealthResponse>("GET", "/health");
  }

  getAccount(address: string, network: Network = this.defaultNetwork): Promise<AccountState> {
    return this.http.request<AccountState>(
      "GET",
      `/${network}/account/${encodeURIComponent(address)}`
    );
  }

  getPaths(
    params: { fromAsset: string; amount: string },
    network: Network = this.defaultNetwork
  ): Promise<PathResponse> {
    const query = new URLSearchParams({ fromAsset: params.fromAsset, amount: params.amount });
    return this.http.request<PathResponse>("GET", `/${network}/paths?${query.toString()}`);
  }

  closePlan(body: ClosePlanRequest, network: Network = this.defaultNetwork): Promise<PlanResponse> {
    return this.http.request<PlanResponse>("POST", `/v1/${network}/close/plan`, body);
  }

  /**
   * Builds the next unsigned transaction(s) for a close. A close can span several
   * transactions (a fused close, or separate claim / cleanup / mediator-merge steps),
   * so the response's `remaining.requiresAnotherCall` says whether more follow: sign and
   * submit the returned transactions in `order`, wait for confirmation, then call this
   * again until `requiresAnotherCall` is false.
   */
  closeTransactions(
    body: CloseTransactionsRequest,
    network: Network = this.defaultNetwork
  ): Promise<TransactionsResponse> {
    return this.http.request<TransactionsResponse>(
      "POST",
      `/v1/${network}/close/transactions`,
      body
    );
  }

  submit(signedXdr: string, network: Network = this.defaultNetwork): Promise<SubmitResponse> {
    return this.http.request<SubmitResponse>("POST", `/v1/${network}/submit`, { signedXdr });
  }

  mediatorCheck(
    address: string,
    network: Network = this.defaultNetwork
  ): Promise<MediatorCheckResult> {
    return this.http.request<MediatorCheckResult>(
      "GET",
      `/${network}/mediator/check/${encodeURIComponent(address)}`
    );
  }

  mediatorSign(
    transaction: string,
    network: Network = this.defaultNetwork
  ): Promise<MediatorSignResponse> {
    return this.http.request<MediatorSignResponse>("POST", `/${network}/mediator/sign`, {
      transaction,
    });
  }
}
