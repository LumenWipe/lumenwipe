import { NextRequest } from "next/server";
import {
  CSP_REPORT_LIMIT_PER_DAY,
  cspReportMethodNotAllowed,
  cspReportResponse,
} from "@/lib/api/csp-report";
import { rateLimitProxy } from "@/lib/api/rate-limit";

/** Receives the CSP's violation reports (`report-to csp`) and logs only what was blocked. */
export async function POST(req: NextRequest): Promise<Response> {
  return cspReportResponse(req, {
    rateLimit: (request) =>
      rateLimitProxy(request, "csp-report", { limitPerDay: CSP_REPORT_LIMIT_PER_DAY }),
    log: (line) => console.warn(line),
  });
}

export const GET = cspReportMethodNotAllowed;
export const PUT = cspReportMethodNotAllowed;
export const PATCH = cspReportMethodNotAllowed;
export const DELETE = cspReportMethodNotAllowed;
