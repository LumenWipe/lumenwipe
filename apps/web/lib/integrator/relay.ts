import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { rateLimitProxy } from "@/lib/api/rate-limit";
import { buildUpstreamRequest } from "./upstream";

/**
 * Relays an integrator request to the API's `/integrator/*` routes. These authenticate with the
 * user's own wallet session, so the browser's `Authorization` header is forwarded as-is and the
 * shared server-side API key is deliberately never attached.
 */
export async function relayIntegrator(
  req: NextRequest,
  path: string,
  method: "GET" | "POST"
): Promise<NextResponse> {
  const limited = await rateLimitProxy(req, "integrator");
  if (limited) return limited;

  const baseUrl = process.env.LUMENWIPE_API_URL;
  if (!baseUrl) {
    console.error("Integrator proxy error: LUMENWIPE_API_URL is not configured.");
    return NextResponse.json({ error: "The API is currently unavailable." }, { status: 502 });
  }

  const bodyText = method === "POST" ? await req.text() : "";
  const { url, init } = buildUpstreamRequest(
    baseUrl,
    path,
    method,
    req.headers.get("authorization"),
    bodyText
  );

  try {
    const upstream = await fetch(url, init);
    const payload: unknown = await upstream.json().catch(() => ({
      error: { code: "upstream_error", message: "The API returned an unexpected response." },
    }));
    return NextResponse.json(payload, {
      status: upstream.status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    console.error("Integrator proxy error:", e);
    return NextResponse.json({ error: "The API is currently unavailable." }, { status: 502 });
  }
}
