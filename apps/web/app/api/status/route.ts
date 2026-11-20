import { NextResponse } from "next/server";
import { statusSource } from "@/lib/status/source";
import { parseStatusSummary, type StatusReport } from "@/lib/status/summary";

const CACHE_CONTROL = "public, s-maxage=60";
const STATUS_TIMEOUT_MS = 3_000;

function nothingToShow(): NextResponse {
  return new NextResponse(null, { status: 204, headers: { "Cache-Control": CACHE_CONTROL } });
}

/**
 * The status host's summary for the site banner, read server-side so the browser only ever talks
 * to this origin. A 204 means there is nothing to show: no source configured, or a host that is
 * unreachable, slow, redirecting or answering something other than a summary.
 */
export async function GET() {
  const source = statusSource();
  if (!source) return nothingToShow();
  try {
    const res = await fetch(source, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    if (!res.ok) return nothingToShow();
    const summary = parseStatusSummary(await res.json());
    if (!summary) return nothingToShow();
    const report: StatusReport = { ...summary, page: source.origin };
    return NextResponse.json(report, { headers: { "Cache-Control": CACHE_CONTROL } });
  } catch {
    return nothingToShow();
  }
}
