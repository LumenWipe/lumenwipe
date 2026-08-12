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

  cached = new LumenWipeClient({ baseUrl, apiKey });
  return cached;
}
