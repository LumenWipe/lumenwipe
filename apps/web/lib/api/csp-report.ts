import { NextRequest, NextResponse } from "next/server";

/** Larger bodies are dropped unread past this many bytes. A real report batch is a few KiB. */
export const CSP_REPORT_MAX_BYTES = 16 * 1024;
/** At most this many violations are logged from one batch. */
export const CSP_REPORT_MAX_ENTRIES = 20;
/** Its own limiter bucket, so reports never spend a caller's close-flow budget. */
export const CSP_REPORT_LIMIT_PER_DAY = 100;

const NO_STORE = { "Cache-Control": "no-store" };

const DIRECTIVES = new Set([
  "default-src",
  "script-src",
  "script-src-elem",
  "script-src-attr",
  "style-src",
  "style-src-elem",
  "style-src-attr",
  "img-src",
  "font-src",
  "connect-src",
  "frame-src",
  "child-src",
  "worker-src",
  "manifest-src",
  "media-src",
  "object-src",
  "frame-ancestors",
  "base-uri",
  "form-action",
  "fenced-frame-src",
  "require-trusted-types-for",
  "trusted-types",
]);

const BLOCKED_KEYWORDS = new Set([
  "inline",
  "eval",
  "wasm-eval",
  "trusted-types-policy",
  "trusted-types-sink",
]);

const NETWORK_SCHEMES = new Set(["http:", "https:", "ws:", "wss:"]);

export interface CspReportDeps {
  rateLimit: (req: NextRequest) => Promise<NextResponse | null>;
  log: (line: string) => void;
}

/**
 * What a blocked URL is reduced to: the origin of a network URL, the scheme alone for any other
 * URL (an extension's id stays out), or the browser's keyword for inline code and eval.
 */
export function blockedSource(value: unknown): string {
  if (typeof value !== "string") return "other";
  if (BLOCKED_KEYWORDS.has(value)) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "other";
  }
  return NETWORK_SCHEMES.has(url.protocol) ? url.origin : url.protocol;
}

/**
 * The log lines for a Reporting API batch: each CSP violation as its directive and the reduced
 * blocked source. Nothing else in a report is kept: the document URL, referrer, source file and
 * sample can name an account or carry page content.
 */
export function violationLines(batch: unknown): string[] {
  if (!Array.isArray(batch)) return [];
  const lines: string[] = [];
  for (const report of batch.slice(0, CSP_REPORT_MAX_ENTRIES)) {
    if (typeof report !== "object" || report === null) continue;
    const { type, body } = report as { type?: unknown; body?: unknown };
    if (type !== "csp-violation" || typeof body !== "object" || body === null) continue;
    const { effectiveDirective, blockedURL } = body as Record<string, unknown>;
    if (typeof effectiveDirective !== "string" || !DIRECTIVES.has(effectiveDirective)) continue;
    lines.push(`CSP violation: ${effectiveDirective} blocked ${blockedSource(blockedURL)}`);
  }
  return lines;
}

/** The body as text, or null when it is missing or longer than the cap, read no further. */
async function readCapped(req: NextRequest): Promise<string | null> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > CSP_REPORT_MAX_BYTES) return null;
  if (!req.body) return null;
  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > CSP_REPORT_MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isReportsJson(req: NextRequest): boolean {
  const type = req.headers.get("content-type") ?? "";
  return type.split(";")[0]!.trim().toLowerCase() === "application/reports+json";
}

/**
 * The answer to a CSP violation report: 204 for every body it accepts or ignores, 429 when the
 * caller is over its limit. Nothing a report contains is ever echoed back.
 */
export async function cspReportResponse(req: NextRequest, deps: CspReportDeps): Promise<Response> {
  if (!isReportsJson(req)) return new NextResponse(null, { status: 204, headers: NO_STORE });
  const limited = await deps.rateLimit(req);
  if (limited) {
    limited.headers.set("Cache-Control", "no-store");
    return limited;
  }
  const text = await readCapped(req);
  if (text !== null) for (const line of violationLines(parse(text))) deps.log(line);
  return new NextResponse(null, { status: 204, headers: NO_STORE });
}

/** Any method but POST. */
export function cspReportMethodNotAllowed(): Response {
  return new NextResponse(null, { status: 405, headers: { ...NO_STORE, Allow: "POST" } });
}
