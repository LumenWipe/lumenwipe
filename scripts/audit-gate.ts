import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Severity = "low" | "moderate" | "high" | "critical";

export interface AuditAdvisory {
  id: number;
  url: string;
  title: string;
  severity: Severity;
  vulnerable_versions: string;
}

export type AuditReport = Record<string, AuditAdvisory[]>;

export interface AllowlistEntry {
  advisory: string;
  package: string;
  severity: Severity;
  reason: string;
  added: string;
  expires: string;
}

export interface Finding {
  package: string;
  advisory: string;
  severity: Severity;
  title: string;
}

export interface Verdict {
  failures: Finding[];
  allowed: Finding[];
  informational: Finding[];
  expired: AllowlistEntry[];
  stale: AllowlistEntry[];
  invalid: string[];
}

const SEVERITIES: readonly Severity[] = ["low", "moderate", "high", "critical"];
const BLOCKING: readonly Severity[] = ["high", "critical"];
const MAX_ALLOWLIST_DAYS = 92;
const DAY_MS = 86_400_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseReport(raw: string): AuditReport {
  const start = raw.indexOf("{");
  if (start === -1) throw new Error("bun audit returned no JSON document");
  const parsed: unknown = JSON.parse(raw.slice(start));
  if (!isRecord(parsed)) throw new Error("bun audit returned an unexpected JSON shape");
  const report: AuditReport = {};
  for (const [pkg, list] of Object.entries(parsed)) {
    if (!Array.isArray(list)) throw new Error(`bun audit entry for ${pkg} is not a list`);
    report[pkg] = list.map((item): AuditAdvisory => {
      if (
        !isRecord(item) ||
        typeof item.url !== "string" ||
        typeof item.title !== "string" ||
        typeof item.severity !== "string" ||
        !SEVERITIES.includes(item.severity as Severity)
      ) {
        throw new Error(`bun audit advisory for ${pkg} has an unexpected shape`);
      }
      return {
        id: typeof item.id === "number" ? item.id : 0,
        url: item.url,
        title: item.title,
        severity: item.severity as Severity,
        vulnerable_versions:
          typeof item.vulnerable_versions === "string" ? item.vulnerable_versions : "",
      };
    });
  }
  return report;
}

export function parseAllowlist(raw: string): AllowlistEntry[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("allowlist must be a JSON array");
  return parsed.map((item, index): AllowlistEntry => {
    const label = `allowlist entry ${index}`;
    if (!isRecord(item)) throw new Error(`${label} is not an object`);
    for (const key of ["advisory", "package", "severity", "reason", "added", "expires"]) {
      if (typeof item[key] !== "string" || item[key] === "") {
        throw new Error(`${label} is missing "${key}"`);
      }
    }
    if (!SEVERITIES.includes(item.severity as Severity)) {
      throw new Error(`${label} has an invalid severity`);
    }
    return item as unknown as AllowlistEntry;
  });
}

function advisoryId(url: string): string {
  return url.slice(url.lastIndexOf("/") + 1);
}

function toDay(value: string): number {
  const time = Date.parse(`${value}T00:00:00Z`);
  return time;
}

export function evaluate(report: AuditReport, allowlist: AllowlistEntry[], today: string): Verdict {
  const verdict: Verdict = {
    failures: [],
    allowed: [],
    informational: [],
    expired: [],
    stale: [],
    invalid: [],
  };
  const now = toDay(today);
  const live = new Set<string>();

  const findings: Finding[] = Object.entries(report).flatMap(([pkg, list]) =>
    list.map((a) => ({
      package: pkg,
      advisory: advisoryId(a.url),
      severity: a.severity,
      title: a.title,
    }))
  );
  for (const f of findings) live.add(`${f.package}|${f.advisory}`);

  for (const entry of allowlist) {
    const added = toDay(entry.added);
    const expires = toDay(entry.expires);
    if (Number.isNaN(added) || Number.isNaN(expires)) {
      verdict.invalid.push(`${entry.advisory}: added and expires must be YYYY-MM-DD dates`);
    } else if (expires - added > MAX_ALLOWLIST_DAYS * DAY_MS) {
      verdict.invalid.push(`${entry.advisory}: expiry is more than ${MAX_ALLOWLIST_DAYS} days out`);
    } else if (expires < now) {
      verdict.expired.push(entry);
    }
    if (!live.has(`${entry.package}|${entry.advisory}`)) verdict.stale.push(entry);
  }

  const active = new Set(
    allowlist
      .filter((e) => {
        const expires = toDay(e.expires);
        return !Number.isNaN(expires) && expires >= now;
      })
      .map((e) => `${e.package}|${e.advisory}`)
  );

  for (const f of findings) {
    if (!BLOCKING.includes(f.severity)) verdict.informational.push(f);
    else if (active.has(`${f.package}|${f.advisory}`)) verdict.allowed.push(f);
    else verdict.failures.push(f);
  }
  return verdict;
}

export function isPassing(verdict: Verdict): boolean {
  return (
    verdict.failures.length === 0 &&
    verdict.expired.length === 0 &&
    verdict.stale.length === 0 &&
    verdict.invalid.length === 0
  );
}

function runAudit(attempts: number): string {
  let lastError = "no output";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = spawnSync("bun", ["audit", "--json"], { encoding: "utf8" });
    const out = result.stdout ?? "";
    try {
      parseReport(out);
      return out;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      console.error(`audit attempt ${attempt}/${attempts} failed: ${lastError}`);
      if (attempt < attempts) spawnSync("sleep", [String(attempt * 5)]);
    }
  }
  throw new Error(
    `The advisory endpoint could not be reached or returned unusable data: ${lastError}`
  );
}

function print(title: string, findings: Finding[]): void {
  if (findings.length === 0) return;
  console.log(`\n${title}`);
  for (const f of findings)
    console.log(`  ${f.severity.padEnd(8)} ${f.package}  ${f.advisory}  ${f.title}`);
}

function main(): number {
  const dir = dirname(fileURLToPath(import.meta.url));
  const allowlist = parseAllowlist(readFileSync(join(dir, "audit-allowlist.json"), "utf8"));
  let report: AuditReport;
  try {
    report = parseReport(runAudit(3));
  } catch (error) {
    console.error(`\nAudit gate could not run: ${error instanceof Error ? error.message : error}`);
    console.error("Failing instead of passing silently. Re-run the job once the endpoint is back.");
    return 1;
  }
  const verdict = evaluate(report, allowlist, new Date().toISOString().slice(0, 10));

  print("Blocking advisories (high or critical, not allowlisted)", verdict.failures);
  print("Allowlisted advisories (reviewed, with expiry)", verdict.allowed);
  print("Below the gate threshold (informational)", verdict.informational);
  for (const e of verdict.expired)
    console.log(`\nExpired allowlist entry: ${e.package} ${e.advisory} (${e.expires})`);
  for (const e of verdict.stale)
    console.log(`\nStale allowlist entry, remove it: ${e.package} ${e.advisory}`);
  for (const message of verdict.invalid) console.log(`\nInvalid allowlist entry: ${message}`);

  if (isPassing(verdict)) {
    console.log("\nAudit gate passed.");
    return 0;
  }
  console.log("\nAudit gate failed.");
  return 1;
}

if (import.meta.main) process.exit(main());
