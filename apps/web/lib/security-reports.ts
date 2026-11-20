import REPORTS from "@/content/security-reports.json";

export const SEVERITIES = ["critical", "high", "medium", "low", "informational"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const FIX_STATUSES = ["fixed", "mitigated", "accepted", "open"] as const;
export type FixStatus = (typeof FIX_STATUSES)[number];

export interface Finding {
  id: string;
  title: string;
  severity: Severity;
  status: FixStatus;
}

/** One published security report, as `content/security-reports.json` lists it. */
export interface SecurityReport {
  id: string;
  title: string;
  scope: string;
  /** The day the report was delivered, `YYYY-MM-DD`. */
  date: string;
  performedBy: string;
  /** The full hash of the commit the report reviewed. */
  commit: string;
  /** The raw report document, https only. */
  reportUrl: string;
  findings: Finding[];
}

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const COMMIT = /^[0-9a-f]{40}$/;

class SecurityReportError extends Error {}

function fail(where: string, message: string): never {
  throw new SecurityReportError(`content/security-reports.json ${where}: ${message}`);
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(where, "must be an object");
  }
  return value as Record<string, unknown>;
}

function text(entry: Record<string, unknown>, key: string, where: string): string {
  const value = entry[key];
  if (typeof value !== "string" || value.trim() === "")
    fail(where, `"${key}" must be a non-empty string`);
  return value;
}

function oneOf<T extends string>(
  entry: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  where: string
): T {
  const value = entry[key];
  if (!allowed.includes(value as T)) fail(where, `"${key}" must be one of ${allowed.join(", ")}`);
  return value as T;
}

function isCalendarDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** The https URL of a report document, normalized; anything else is refused, since it is an href. */
function reportUrl(value: string, where: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail(where, '"reportUrl" must be an absolute URL');
  }
  if (url.protocol !== "https:") fail(where, '"reportUrl" must use https');
  if (url.username || url.password) fail(where, '"reportUrl" must not carry credentials');
  return url.href;
}

function parseFinding(value: unknown, where: string): Finding {
  const entry = record(value, where);
  return {
    id: text(entry, "id", where),
    title: text(entry, "title", where),
    severity: oneOf(entry, "severity", SEVERITIES, where),
    status: oneOf(entry, "status", FIX_STATUSES, where),
  };
}

function parseReport(value: unknown, index: number): SecurityReport {
  const where = `entry ${index}`;
  const entry = record(value, where);
  const id = text(entry, "id", where);
  if (!ID.test(id)) fail(where, '"id" must be lowercase letters and digits joined by hyphens');
  const date = text(entry, "date", where);
  if (!isCalendarDate(date)) fail(where, '"date" must be a calendar date, YYYY-MM-DD');
  const commit = text(entry, "commit", where);
  if (!COMMIT.test(commit)) fail(where, '"commit" must be a full 40-character commit hash');
  const findings = entry.findings;
  if (!Array.isArray(findings)) fail(where, '"findings" must be a list');
  return {
    id,
    title: text(entry, "title", where),
    scope: text(entry, "scope", where),
    date,
    performedBy: text(entry, "performedBy", where),
    commit,
    reportUrl: reportUrl(text(entry, "reportUrl", where), where),
    findings: findings.map((finding, i) => parseFinding(finding, `${where}, finding ${i}`)),
  };
}

/** The reports in `data`, newest first. A malformed entry throws, so it fails the build rather
 *  than reaching the page: every value here is rendered, and two of them are links. */
export function parseSecurityReports(data: unknown): SecurityReport[] {
  if (!Array.isArray(data)) fail("", "must be a list");
  const reports = data.map(parseReport);
  const ids = new Set(reports.map((r) => r.id));
  if (ids.size !== reports.length) fail("", "has two entries with the same id");
  return reports.sort((a, b) => b.date.localeCompare(a.date));
}

/** The published security reports, newest first. */
export function securityReports(): SecurityReport[] {
  return parseSecurityReports(REPORTS);
}

/** How many findings a report has at each severity, every severity listed. */
export function severityCounts(report: SecurityReport): Record<Severity, number> {
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  for (const finding of report.findings) counts[finding.severity] += 1;
  return counts;
}
