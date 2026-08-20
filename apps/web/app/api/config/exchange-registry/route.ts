import { NextRequest, NextResponse } from "next/server";
import { rateLimitProxy } from "@/lib/api/rate-limit";

/**
 * Proxies the API's exchange registry.
 *
 * Rate-limited like every other proxy route. It reads no API key because the endpoint is
 * `@Public()` - the registry is the same data the web would otherwise ship in its bundle - but
 * "needs no key" is not "should be an unmetered passthrough from the public origin to the API",
 * especially on an instance capped at one replica.
 *
 * A failure is answered with the status, never a fabricated payload. The client falls back to
 * its bundled floor, and whether that floor may be relied on is decided by its own expiry - a
 * placeholder invented here would defeat both.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const limited = await rateLimitProxy(req, "registry");
  if (limited) return limited as unknown as NextResponse;

  const base = process.env.LUMENWIPE_API_URL;
  if (!base) {
    return NextResponse.json({ error: "API URL is not configured." }, { status: 500 });
  }
  try {
    const res = await fetch(`${base}/config/exchange-registry`, {
      // Explicitly time-bounded and revalidated per request rather than prerendered: whether a
      // route-level `revalidate` takes effect depends on whether the API happened to be
      // reachable from the build container, which is not a property to leave to chance for the
      // data that decides an exchange close.
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      return NextResponse.json({ error: "Registry unavailable." }, { status: res.status });
    }
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ error: "Registry unreachable." }, { status: 502 });
  }
}
