import { LumenWipeApiError, LumenWipeTimeoutError } from "./errors";
import type { FetchLike } from "./options";

/**
 * Low-level transport: sends `Authorization: Bearer <key>`, applies the request
 * timeout, and turns responses into typed results or errors. Kept separate from
 * the endpoint-facing client so the HTTP concerns live in one place.
 */
export class HttpTransport {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeout: number,
    private readonly doFetch: FetchLike
  ) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const controller = new AbortController();
    const bounded = Number.isFinite(this.timeout) && this.timeout > 0;
    const timer = bounded ? setTimeout(() => controller.abort(), this.timeout) : undefined;

    try {
      const res = await this.doFetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
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
    } catch (e) {
      if (controller.signal.aborted) throw new LumenWipeTimeoutError(this.timeout);
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
