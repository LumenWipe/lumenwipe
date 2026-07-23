import { SE_API_BASE } from "@/config/networks";
import { SE_API_TIMEOUT_MS, SE_API_MAX_RETRIES } from "@/config/constants";
import type { Network } from "@/config/networks";

export class SeApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = "SeApiError";
  }
}

export async function seGet<T>(
  network: Network,
  path: string,
  params?: Record<string, string>
): Promise<T> {
  const base = SE_API_BASE[network];
  const url = new URL(`${base}${path}`);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < SE_API_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), SE_API_TIMEOUT_MS);

      const res = await fetch(url.toString(), {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });

      clearTimeout(timeout);

      if (!res.ok) {
        throw new SeApiError(res.status, `SE API error: ${res.status} ${res.statusText}`);
      }

      return (await res.json()) as T;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (err instanceof SeApiError && err.status < 500) throw err;
    }
  }

  throw lastError ?? new Error("SE API request failed after retries");
}
