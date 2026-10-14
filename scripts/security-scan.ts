import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseReport, type AuditReport } from "./audit-gate";

export type Severity = "critical" | "high" | "medium" | "low";
export type ToolName = "bun audit" | "semgrep" | "gitleaks";

export interface ToolPins {
  semgrep: { version: string; configs: string[]; targets: string[]; flags: string[] };
  gitleaks: {
    version: string;
    linuxSha256: string;
    config: string;
    ignore: string;
    logOpts: string;
    flags: string[];
  };
}

export interface ScanFinding {
  tool: ToolName;
  severity: Severity;
  rule: string;
  location: string;
  title: string;
}

export interface ToolRun {
  tool: ToolName;
  version: string;
  command: string;
  findings: ScanFinding[];
  notes: string[];
}

export interface ScanReport {
  date: string;
  commit: string;
  dirty: boolean;
  tools: ToolRun[];
}

export const SEVERITIES: readonly Severity[] = ["critical", "high", "medium", "low"];
const REPORTS_DIR = "security-reports";

const INSTALL: Record<"semgrep" | "gitleaks", (pins: ToolPins) => string> = {
  semgrep: (pins) => `pipx install semgrep==${pins.semgrep.version}`,
  gitleaks: (pins) =>
    `download v${pins.gitleaks.version} from https://github.com/gitleaks/gitleaks/releases/tag/v${pins.gitleaks.version} (Homebrew works only while its formula is at that version)`,
};

export function readPins(path: string): ToolPins {
  return JSON.parse(readFileSync(path, "utf8")) as ToolPins;
}

/** The local calendar date, so an evening run is not dated tomorrow. */
export function localDate(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * One plain line per tool that is missing or not at the pinned version, so two reports stay
 * comparable. `installed` maps a tool to its reported version, or null when it did not run.
 */
export function toolProblems(
  installed: Record<"semgrep" | "gitleaks", string | null>,
  pins: ToolPins
): string[] {
  const problems: string[] = [];
  for (const tool of ["semgrep", "gitleaks"] as const) {
    const version = installed[tool];
    const pinned = pins[tool].version;
    if (version === null) {
      problems.push(`${tool} is not installed. Install it with: ${INSTALL[tool](pins)}`);
    } else if (version !== pinned) {
      problems.push(
        `${tool} ${version} is installed, but CI pins ${pinned}. Install it with: ${INSTALL[tool](pins)}`
      );
    }
  }
  return problems;
}

/** The packages that depend on `pkg` directly, read from `bun pm why <pkg> --top`. */
export function directDependents(whyOutput: string): string[] {
  const names = [...whyOutput.matchAll(/[├└]─\s+(?:dev |peer |optional )*(@?[^@\s]+)@/g)].map(
    (m) => m[1]!
  );
  return [...new Set(names)];
}

const AUDIT_SEVERITY: Record<string, Severity> = {
  critical: "critical",
  high: "high",
  moderate: "medium",
  low: "low",
};

export function auditFindings(
  report: AuditReport,
  dependents: (pkg: string) => string[] = () => []
): ScanFinding[] {
  return Object.entries(report).flatMap(([pkg, advisories]) => {
    const via = dependents(pkg);
    const location = via.length > 0 ? `${pkg} (via ${via.join(", ")})` : pkg;
    return advisories.map((advisory) => {
      const severity = AUDIT_SEVERITY[advisory.severity];
      if (severity === undefined) {
        throw new Error(`bun audit gave ${pkg} an unknown severity: ${String(advisory.severity)}`);
      }
      return {
        tool: "bun audit" as const,
        severity,
        rule: advisory.url.split("/").pop() || String(advisory.id),
        location,
        title: advisory.title,
      };
    });
  });
}

const SEMGREP_SEVERITY: Record<string, Severity> = {
  CRITICAL: "critical",
  ERROR: "high",
  HIGH: "high",
  WARNING: "medium",
  MEDIUM: "medium",
  INFO: "low",
  LOW: "low",
};

interface SemgrepJson {
  results?: {
    check_id: string;
    path: string;
    start?: { line?: number };
    extra?: {
      severity?: string;
      message?: string;
      metavars?: Record<string, { abstract_content?: string }>;
    };
  }[];
  errors?: { type?: unknown; path?: string; spans?: { file?: string }[] }[];
}

/**
 * Semgrep fills a rule's `$VARS` into its message with the matched source, which for a secrets
 * rule is the secret itself, so every bound value is replaced before the message is kept.
 */
export function redactMessage(
  message: string,
  metavars: Record<string, { abstract_content?: string }> = {}
): string {
  let text = message.split("\n")[0]!.trim();
  const values = Object.values(metavars)
    .map((m) => m.abstract_content ?? "")
    .filter((v) => v.trim() !== "")
    .sort((a, b) => b.length - a.length);
  for (const value of values) text = text.split(value).join("[redacted]");
  return text.replace(/\$[A-Z_][A-Z0-9_]*/g, "[redacted]");
}

export function semgrepFindings(raw: string): { findings: ScanFinding[]; errors: string[] } {
  const parsed = JSON.parse(raw) as SemgrepJson;
  const findings = (parsed.results ?? []).map((r) => ({
    tool: "semgrep" as const,
    severity: SEMGREP_SEVERITY[(r.extra?.severity ?? "").toUpperCase()] ?? "high",
    rule: r.check_id,
    location: `${r.path}:${r.start?.line ?? 0}`,
    title: redactMessage(r.extra?.message ?? "", r.extra?.metavars),
  }));
  const errors = (parsed.errors ?? []).map((e) => {
    const kind = Array.isArray(e.type) ? String(e.type[0]) : String(e.type ?? "error");
    const file = e.path ?? e.spans?.[0]?.file;
    return file ? `${kind} in ${file}` : kind;
  });
  return { findings, errors: [...new Set(errors)] };
}

interface GitleaksLeak {
  RuleID: string;
  Description?: string;
  File: string;
  StartLine?: number;
  Commit?: string;
}

/** Secret text is never copied: only the rule, file, line and commit leave gitleaks' output. */
export function gitleaksFindings(raw: string): ScanFinding[] {
  const leaks = (raw.trim() === "" ? [] : JSON.parse(raw)) as GitleaksLeak[];
  return leaks.map((leak) => ({
    tool: "gitleaks" as const,
    severity: "high" as const,
    rule: leak.RuleID,
    location: `${leak.File}:${leak.StartLine ?? 0}${leak.Commit ? ` @ ${leak.Commit.slice(0, 7)}` : ""}`,
    title: leak.Description ?? leak.RuleID,
  }));
}

export function countBySeverity(findings: ScanFinding[]): Record<Severity, number> {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const finding of findings) counts[finding.severity]++;
  return counts;
}

/** Plain text in a Markdown table or line: nothing in a finding can render as markup. */
export function escapeMarkdown(text: string): string {
  return text.replace(/\s+/g, " ").replace(/[\\`*_[\]<>|]/g, "\\$&");
}

export function renderMarkdown(report: ScanReport): string {
  const lines = [
    `# Security tooling report, ${report.date}`,
    "",
    `Commit \`${report.commit}\`${report.dirty ? " with uncommitted changes" : ""}. Written by \`bun run security:scan\`. ` +
      "This report records what the tools found; it does not decide pass or fail.",
    "",
    "| Tool | Version | Critical | High | Medium | Low |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const run of report.tools) {
    const c = countBySeverity(run.findings);
    lines.push(
      `| ${run.tool} | ${run.version} | ${c.critical} | ${c.high} | ${c.medium} | ${c.low} |`
    );
  }
  for (const run of report.tools) {
    lines.push("", `## ${run.tool}`, "", "```", run.command, "```", "");
    for (const note of run.notes) lines.push(escapeMarkdown(note), "");
    if (run.findings.length === 0) {
      lines.push("No findings.");
      continue;
    }
    lines.push("| Severity | Rule | Location | Finding |", "| --- | --- | --- | --- |");
    const sorted = [...run.findings].sort(
      (a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity)
    );
    for (const f of sorted) {
      lines.push(
        `| ${f.severity} | ${escapeMarkdown(f.rule)} | ${escapeMarkdown(f.location)} | ${escapeMarkdown(f.title)} |`
      );
    }
  }
  return lines.join("\n") + "\n";
}

export function renderJson(report: ScanReport): string {
  return (
    JSON.stringify(
      {
        date: report.date,
        commit: report.commit,
        dirty: report.dirty,
        tools: report.tools.map((run) => ({
          ...run,
          counts: countBySeverity(run.findings),
        })),
      },
      null,
      2
    ) + "\n"
  );
}

function run(command: string, args: string[], cwd: string) {
  return spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

/** Runs a command that must succeed and returns its trimmed stdout. */
function must(command: string, args: string[], cwd: string): string {
  const result = run(command, args, cwd);
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr.trim();
    throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
  }
  return result.stdout.trim();
}

function versionOf(command: string, args: string[], cwd: string): string | null {
  const result = run(command, args, cwd);
  if (result.error || result.status !== 0) return null;
  return (result.stdout.match(/\d+\.\d+\.\d+/) ?? [null])[0];
}

function main(): number {
  const root = resolve(import.meta.dir, "..");
  const pins = readPins(join(root, "scripts", "security-tools.json"));
  const installed = {
    semgrep: versionOf("semgrep", ["--version"], root),
    gitleaks: versionOf("gitleaks", ["version"], root),
  };
  const problems = toolProblems(installed, pins);
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    return 1;
  }

  const commit = must("git", ["rev-parse", "HEAD"], root);
  const dirty = must("git", ["status", "--porcelain", "--", ".", `:!${REPORTS_DIR}`], root) !== "";
  const date = localDate();
  const scratch = mkdtempSync(join(tmpdir(), "security-scan-"));

  try {
    const bun = process.execPath;
    const audit = run(bun, ["audit", "--json"], root);
    if (audit.error) throw new Error(`bun audit could not run: ${audit.error.message}`);
    let auditReport: AuditReport;
    try {
      auditReport = parseReport(audit.stdout);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`bun audit gave no usable report (${reason}): ${audit.stderr.trim()}`);
    }
    const auditRun: ToolRun = {
      tool: "bun audit",
      version: must(bun, ["--version"], root),
      command: "bun audit --json",
      findings: auditFindings(auditReport, (pkg) =>
        directDependents(run(bun, ["pm", "why", pkg, "--top"], root).stdout)
      ),
      notes: [],
    };

    const semgrepArgs = [
      "scan",
      ...pins.semgrep.configs.flatMap((config) => ["--config", config]),
      ...pins.semgrep.flags,
      "--json",
      "--quiet",
      ...pins.semgrep.targets,
    ];
    const semgrep = run("semgrep", semgrepArgs, root);
    if (semgrep.error || semgrep.status !== 0) {
      throw new Error(`semgrep exited with ${semgrep.status}: ${semgrep.stderr.trim()}`);
    }
    const semgrepResult = semgrepFindings(semgrep.stdout);
    const semgrepRun: ToolRun = {
      tool: "semgrep",
      version: installed.semgrep!,
      command: `semgrep ${semgrepArgs.join(" ")}`,
      findings: semgrepResult.findings,
      notes:
        semgrepResult.errors.length > 0
          ? [`Semgrep reported analysis errors: ${semgrepResult.errors.join("; ")}.`]
          : [],
    };

    const logOpts = pins.gitleaks.logOpts.split(/\s+/).filter(Boolean);
    const commits = Number(must("git", ["rev-list", "--count", ...logOpts], root));
    if (!Number.isInteger(commits) || commits === 0) {
      throw new Error(`git rev-list ${pins.gitleaks.logOpts} selects no commits to scan`);
    }
    const reportPath = join(scratch, "gitleaks.json");
    const gitleaksArgs = [
      "git",
      `--log-opts=${pins.gitleaks.logOpts}`,
      "--config",
      pins.gitleaks.config,
      "--gitleaks-ignore-path",
      pins.gitleaks.ignore,
      ...pins.gitleaks.flags,
      "--exit-code",
      "0",
      "--report-format",
      "json",
      "--report-path",
      reportPath,
      ".",
    ];
    const gitleaks = run("gitleaks", gitleaksArgs, root);
    let gitleaksOutput: string;
    try {
      if (gitleaks.error || gitleaks.status !== 0) throw new Error(`exit ${gitleaks.status}`);
      gitleaksOutput = readFileSync(reportPath, "utf8");
    } catch {
      throw new Error(`gitleaks failed: ${gitleaks.stderr.trim()}`);
    }
    const gitleaksRun: ToolRun = {
      tool: "gitleaks",
      version: installed.gitleaks!,
      command: `gitleaks ${gitleaksArgs.map((arg) => (arg === reportPath ? "<report.json>" : arg)).join(" ")}`,
      findings: gitleaksFindings(gitleaksOutput),
      notes: [
        `Scanned the history reachable from ${pins.gitleaks.logOpts}: ${commits} commits (merge commits add no diff of their own). Secret values are redacted and never copied into this report.`,
      ],
    };

    const report: ScanReport = {
      date,
      commit,
      dirty,
      tools: [auditRun, semgrepRun, gitleaksRun],
    };
    const outDir = join(root, REPORTS_DIR);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, `${date}.md`), renderMarkdown(report));
    writeFileSync(join(outDir, `${date}.json`), renderJson(report));
    console.log(`Wrote ${REPORTS_DIR}/${date}.md and ${REPORTS_DIR}/${date}.json`);
    for (const toolRun of report.tools) {
      const c = countBySeverity(toolRun.findings);
      console.log(
        `  ${toolRun.tool.padEnd(10)} ${toolRun.version.padEnd(8)} critical ${c.critical}, high ${c.high}, medium ${c.medium}, low ${c.low}`
      );
    }
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
