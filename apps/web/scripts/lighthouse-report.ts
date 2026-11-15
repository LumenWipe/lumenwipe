/**
 * The Lighthouse step of the a11y job (.github/workflows/ci.yml, apps/web/lighthouserc.json).
 * Reports only: nothing here fails on a score.
 *
 *   git diff --name-only <base>...HEAD | bun scripts/lighthouse-report.ts gate
 *     prints true when the change touches what the web app is built from (the same list the
 *     Vercel ignore step watches, scripts/vercel-ignore.mjs), false otherwise.
 *   bun scripts/lighthouse-report.ts summary <lhci filesystem output dir> <commit>
 *     prints a Markdown table of each route's median run, for the job summary.
 */
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { shouldBuild } from "../../../scripts/vercel-ignore.mjs";

interface NetworkRequest {
  url: string;
  statusCode?: number;
  transferSize?: number;
}

/** The parts of a Lighthouse result this report reads. */
export interface LighthouseResult {
  lighthouseVersion: string;
  categories: { performance?: { score: number | null } };
  audits: Record<
    string,
    { numericValue?: number; details?: { items?: Array<Record<string, unknown>> } } | undefined
  >;
}

export interface RunMetrics {
  score: number;
  lcpMs: number;
  cls: number;
  tbtMs: number;
  scriptBytes: number;
}

export interface ThirdPartyRequest {
  url: string;
  blocked: boolean;
  status: number;
}

export interface ManifestEntry {
  url: string;
  jsonPath: string;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const NETWORK_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);

export function touchesWeb(files: readonly string[]): boolean {
  return files.length > 0 && shouldBuild("web", files);
}

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("median of no values");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function numeric(lhr: LighthouseResult, audit: string): number {
  const value = lhr.audits[audit]?.numericValue;
  if (typeof value !== "number") throw new Error(`the result has no ${audit} value`);
  return value;
}

/** The run's metrics, or null when Lighthouse could not score it (a runtime error). */
export function metricsOf(lhr: LighthouseResult): RunMetrics | null {
  const score = lhr.categories.performance?.score;
  if (typeof score !== "number") return null;
  const scripts = lhr.audits["resource-summary"]?.details?.items?.find(
    (item) => item.resourceType === "script"
  );
  return {
    score: Math.round(score * 100),
    lcpMs: numeric(lhr, "largest-contentful-paint"),
    cls: numeric(lhr, "cumulative-layout-shift"),
    tbtMs: numeric(lhr, "total-blocking-time"),
    scriptBytes: typeof scripts?.transferSize === "number" ? scripts.transferSize : 0,
  };
}

/**
 * Every request the page made to a host other than the local server. The job resolves every other
 * host to nothing, so each one is expected to show as blocked; one that got a response means the
 * run reached a third party after all.
 */
export function thirdPartyRequests(lhr: LighthouseResult): ThirdPartyRequest[] {
  const items = (lhr.audits["network-requests"]?.details?.items ??
    []) as unknown as NetworkRequest[];
  const seen = new Map<string, ThirdPartyRequest>();
  for (const item of items) {
    let parsed: URL;
    try {
      parsed = new URL(item.url);
    } catch {
      continue;
    }
    if (!NETWORK_PROTOCOLS.has(parsed.protocol) || LOCAL_HOSTS.has(parsed.hostname)) continue;
    const url = `${parsed.origin}${parsed.pathname}`;
    const status = item.statusCode ?? -1;
    if (!seen.has(url)) seen.set(url, { url, blocked: status <= 0, status });
  }
  return [...seen.values()];
}

function routeOf(url: string): string {
  return new URL(url).pathname;
}

function formatMs(ms: number): string {
  return `${Math.round(ms)} ms`;
}

function formatKb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function summarize(
  runs: ReadonlyArray<{ url: string; lhr: LighthouseResult }>,
  commit: string
): string {
  const routes = new Map<string, LighthouseResult[]>();
  for (const { url, lhr } of runs) routes.set(url, [...(routes.get(url) ?? []), lhr]);
  const versions = [...new Set(runs.map(({ lhr }) => lhr.lighthouseVersion))].join(", ");

  const lines = [
    "## Lighthouse (mobile, simulated throttling)",
    "",
    `Lighthouse ${versions || "unknown"} at commit \`${commit}\`. Each value is the median over the route's scored runs; report only, no budget is enforced.`,
    "",
    "| Route | Runs | Performance | LCP | CLS | TBT | Transferred JS |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  const thirdParty = new Map<string, ThirdPartyRequest & { routes: Set<string> }>();
  for (const [url, results] of routes) {
    const route = routeOf(url);
    const scored = results.map(metricsOf).filter((m): m is RunMetrics => m !== null);
    if (scored.length === 0) {
      lines.push(`| \`${route}\` | 0 of ${results.length} | no scored run | | | | |`);
    } else {
      const pick = (key: keyof RunMetrics) => median(scored.map((m) => m[key]));
      lines.push(
        `| \`${route}\` | ${scored.length} of ${results.length} | ${pick("score")} | ${formatMs(pick("lcpMs"))} | ${pick("cls").toFixed(3)} | ${formatMs(pick("tbtMs"))} | ${formatKb(pick("scriptBytes"))} |`
      );
    }
    for (const lhr of results) {
      for (const request of thirdPartyRequests(lhr)) {
        const entry = thirdParty.get(request.url) ?? { ...request, routes: new Set<string>() };
        if (!request.blocked) Object.assign(entry, { blocked: false, status: request.status });
        entry.routes.add(route);
        thirdParty.set(request.url, entry);
      }
    }
  }

  lines.push("", "### Third-party requests", "");
  if (thirdParty.size === 0) {
    lines.push("None: every request went to the local server.");
  } else {
    for (const request of thirdParty.values()) {
      const outcome = request.blocked ? "blocked" : `reached (HTTP ${request.status})`;
      const on = [...request.routes].map((r) => `\`${r}\``).join(", ");
      lines.push(`- ${outcome}: ${request.url} (from ${on})`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function readRuns(dir: string): Array<{ url: string; lhr: LighthouseResult }> {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as ManifestEntry[];
  return manifest.map((entry) => ({
    url: entry.url,
    lhr: JSON.parse(readFileSync(join(dir, basename(entry.jsonPath)), "utf8")) as LighthouseResult,
  }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, dir, commit] = process.argv.slice(2);
  if (command === "gate") {
    const files = readFileSync(0, "utf8").split("\n").filter(Boolean);
    console.log(touchesWeb(files) ? "true" : "false");
  } else if (command === "summary" && dir && commit) {
    process.stdout.write(summarize(readRuns(dir), commit));
  } else {
    console.error("usage: lighthouse-report.ts gate | summary <dir> <commit>");
    process.exit(2);
  }
}
