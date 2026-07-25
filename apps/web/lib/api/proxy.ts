import "server-only";
import { NextResponse } from "next/server";
import { LumenWipeApiError, LumenWipeTimeoutError } from "@lumenwipe/sdk";

/**
 * Runs a server-side SDK call and turns it into a NextResponse, re-emitting the
 * upstream API's error body + status verbatim so the browser sees exactly what
 * the API returned. The API is the single source of validation and behavior;
 * these route handlers only inject the key and relay.
 */
export async function proxy<T>(
  fn: () => Promise<T>,
  cacheControl = "no-store"
): Promise<NextResponse> {
  try {
    const data = await fn();
    return NextResponse.json(data, { headers: { "Cache-Control": cacheControl } });
  } catch (e) {
    if (e instanceof LumenWipeApiError) {
      const body =
        typeof e.body === "object" && e.body !== null
          ? e.body
          : { error: String(e.body ?? "Upstream error") };
      return NextResponse.json(body, { status: e.status });
    }
    if (e instanceof LumenWipeTimeoutError) {
      return NextResponse.json({ error: "The API request timed out." }, { status: 504 });
    }
    // Missing LUMENWIPE_API_* config, or the API is unreachable.
    console.error("API proxy error:", e);
    return NextResponse.json({ error: "The API is currently unavailable." }, { status: 502 });
  }
}
