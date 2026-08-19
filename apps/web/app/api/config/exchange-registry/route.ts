import { NextResponse } from "next/server";

/**
 * Proxies the API's exchange registry.
 *
 * Goes through the proxy like every other backend read, so the browser never holds an API key
 * and the endpoint's origin stays a server-side concern. Cached briefly: the data changes on a
 * human's quarterly review, not per request, but the TTL is short enough that a corrected memo
 * rule reaches users the same day rather than whenever a CDN feels like it.
 *
 * A failure here is answered with the status, not a fabricated payload. The client falls back
 * to its bundled floor and its own staleness gate decides whether that floor may be used - a
 * placeholder invented here would defeat both.
 */
export const revalidate = 300;

export async function GET(): Promise<NextResponse> {
  const base = process.env.LUMENWIPE_API_URL;
  if (!base) {
    return NextResponse.json({ error: "API URL is not configured." }, { status: 500 });
  }
  try {
    const res = await fetch(`${base}/config/exchange-registry`, {
      next: { revalidate },
    });
    if (!res.ok) {
      return NextResponse.json({ error: "Registry unavailable." }, { status: res.status });
    }
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ error: "Registry unreachable." }, { status: 502 });
  }
}
