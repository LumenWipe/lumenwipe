import "server-only";
import { LumenWipeClient } from "@lumenwipe/sdk";

/**
 * Server-only accessor for the LumenWipe API client.
 *
 * The API key lives in `LUMENWIPE_API_KEY` - deliberately NOT a `NEXT_PUBLIC_*`
 * var, so Next.js never inlines it into the browser bundle. The `server-only`
 * import above is a second guard: importing this module from a Client Component
 * fails the build. The browser reaches the API only through the same-origin
 * `/api/**` route handlers, which run server-side and use this client.
 */
let cached: LumenWipeClient | null = null;

export function getApiClient(): LumenWipeClient {
  if (cached) return cached;

  const baseUrl = process.env.LUMENWIPE_API_URL;
  const apiKey = process.env.LUMENWIPE_API_KEY;
  if (!baseUrl) throw new Error("LUMENWIPE_API_URL is not configured.");
  if (!apiKey) throw new Error("LUMENWIPE_API_KEY is not configured.");

  // The default (30s) was already tight against the account/close endpoints' own worst-case
  // DeFi-detection budget (OctoPos plus a direct on-chain fallback sweep of hundreds of mainnet
  // pools, ~25s alone) before adding the rest of the account read on top. A client timeout
  // shorter than the server's own realistic worst case means the SDK's clean "request timed
  // out" error can fire before the API ever had a real chance to answer - raised so it lines up
  // with the maxDuration set on the routes that call these endpoints (see their route.ts files).
  cached = new LumenWipeClient({ baseUrl, apiKey, timeout: 45_000 });
  return cached;
}
