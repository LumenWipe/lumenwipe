// The API image's vulnerability gate. Reads the Grype JSON report the CI `docker` job writes for the
// image's SBOM and fails on a high or critical finding that scripts/image-scan-allowlist.json does not
// cover, with the same rules as the dependency audit (scripts/audit-gate.ts): every entry carries a
// reason and an expiry at most 92 days after it was added, and an expired entry or one whose finding
// is gone fails the gate. A report with no distro is refused: without it Grype matches no Debian
// package at all, and an empty result would pass for the wrong reason.
// Usage: bun scripts/image-scan-gate.ts <grype-report.json>
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateFindings,
  parseAllowlist,
  printVerdict,
  type Finding,
  type Severity,
  type Verdict,
  type AllowlistEntry,
} from "./audit-gate";

// Grype's severities onto the audit gate's. Unknown (no rating published yet) stays below the gate
// and is printed, with its own label in the title, rather than blocking on a value nobody has set.
const SEVERITY: Record<string, Severity> = {
  Critical: "critical",
  High: "high",
  Medium: "moderate",
  Low: "low",
  Negligible: "low",
  Unknown: "moderate",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseGrypeReport(raw: string): Finding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("the Grype report is not JSON");
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.matches)) {
    throw new Error("the Grype report has no matches list");
  }
  if (!isRecord(parsed.distro) || typeof parsed.distro.name !== "string" || !parsed.distro.name) {
    throw new Error("the Grype report names no distro, so no OS package was matched");
  }
  const seen = new Set<string>();
  const findings: Finding[] = [];
  for (const [index, match] of parsed.matches.entries()) {
    const vuln = isRecord(match) ? match.vulnerability : undefined;
    const artifact = isRecord(match) ? match.artifact : undefined;
    if (
      !isRecord(vuln) ||
      !isRecord(artifact) ||
      typeof vuln.id !== "string" ||
      typeof vuln.severity !== "string" ||
      !(vuln.severity in SEVERITY) ||
      typeof artifact.name !== "string" ||
      typeof artifact.version !== "string"
    ) {
      throw new Error(`Grype match ${index} has an unexpected shape`);
    }
    const key = `${artifact.name}|${vuln.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const fix = isRecord(vuln.fix) ? vuln.fix : {};
    const fixed =
      fix.state === "fixed" && Array.isArray(fix.versions) && fix.versions.length > 0
        ? `fixed in ${fix.versions.join(", ")}`
        : `fix ${typeof fix.state === "string" ? fix.state : "unknown"}`;
    findings.push({
      package: artifact.name,
      advisory: vuln.id,
      severity: SEVERITY[vuln.severity],
      title: `${artifact.version} (${vuln.severity}, ${fixed})`,
    });
  }
  return findings;
}

export function evaluateReport(raw: string, allowlist: AllowlistEntry[], today: string): Verdict {
  return evaluateFindings(parseGrypeReport(raw), allowlist, today);
}

function main(): number {
  const report = process.argv[2];
  if (!report) {
    console.error("usage: bun scripts/image-scan-gate.ts <grype-report.json>");
    return 2;
  }
  const dir = dirname(fileURLToPath(import.meta.url));
  const allowlist = parseAllowlist(readFileSync(join(dir, "image-scan-allowlist.json"), "utf8"));
  let verdict: Verdict;
  try {
    verdict = evaluateReport(
      readFileSync(report, "utf8"),
      allowlist,
      new Date().toISOString().slice(0, 10)
    );
  } catch (error) {
    console.error(
      `\nImage scan gate could not run: ${error instanceof Error ? error.message : error}`
    );
    return 1;
  }
  return printVerdict(verdict, "Image scan gate", "vulnerabilities") ? 0 : 1;
}

if (import.meta.main) process.exit(main());
