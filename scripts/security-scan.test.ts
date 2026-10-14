import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  auditFindings,
  countBySeverity,
  directDependents,
  escapeMarkdown,
  gitleaksFindings,
  localDate,
  readPins,
  redactMessage,
  renderJson,
  renderMarkdown,
  semgrepFindings,
  toolProblems,
  type ScanReport,
} from "./security-scan";

const pins = readPins(join(import.meta.dir, "security-tools.json"));
const PLACEHOLDER_SECRET = "not-a-real-secret-placeholder";

function report(tools: ScanReport["tools"]): ScanReport {
  return { date: "2026-10-13", commit: "abc1234", dirty: false, tools };
}

function advisory(id: number, severity: string, title = `advisory ${id}`) {
  return {
    id,
    url: `https://github.com/advisories/GHSA-${id}`,
    title,
    severity: severity as "low",
    vulnerable_versions: "<1",
  };
}

describe("the report builder", () => {
  test("an empty result reports zero counts and says so per tool", () => {
    const empty = report([
      {
        tool: "bun audit",
        version: "1.3.14",
        command: "bun audit --json",
        findings: [],
        notes: [],
      },
      {
        tool: "semgrep",
        version: pins.semgrep.version,
        command: "semgrep scan",
        findings: [],
        notes: [],
      },
      {
        tool: "gitleaks",
        version: pins.gitleaks.version,
        command: "gitleaks git",
        findings: [],
        notes: [],
      },
    ]);
    const markdown = renderMarkdown(empty);
    expect(markdown).toContain(`| semgrep | ${pins.semgrep.version} | 0 | 0 | 0 | 0 |`);
    expect(markdown.match(/No findings\./g)).toHaveLength(3);
    const json = JSON.parse(renderJson(empty));
    expect(json.commit).toBe("abc1234");
    expect(json.tools.map((t: { counts: unknown }) => t.counts)).toEqual(
      Array(3).fill({ critical: 0, high: 0, medium: 0, low: 0 })
    );
  });

  test("a mixed-severity result counts each severity and lists the worst first", () => {
    const findings = auditFindings(
      { pkg: [advisory(1, "low"), advisory(2, "critical"), advisory(3, "moderate", "mod | one")] },
      () => ["parent-a", "parent-b"]
    );
    expect(countBySeverity(findings)).toEqual({ critical: 1, high: 0, medium: 1, low: 1 });
    expect(findings[0]!.location).toBe("pkg (via parent-a, parent-b)");
    const markdown = renderMarkdown(
      report([
        { tool: "bun audit", version: "1.3.14", command: "bun audit --json", findings, notes: [] },
      ])
    );
    expect(markdown).toContain("| bun audit | 1.3.14 | 1 | 0 | 1 | 1 |");
    expect(markdown.indexOf("GHSA-2")).toBeLessThan(markdown.indexOf("GHSA-3"));
    expect(markdown.indexOf("GHSA-3")).toBeLessThan(markdown.indexOf("GHSA-1"));
    expect(markdown).toContain("mod \\| one");
  });

  test("text from a finding cannot render as markup", () => {
    expect(escapeMarkdown("a `b` <img> [x](y) | *z*")).toBe(
      "a \\`b\\` \\<img\\> \\[x\\](y) \\| \\*z\\*"
    );
  });

  test("a dirty tree is stated in the report", () => {
    expect(renderMarkdown({ ...report([]), dirty: true })).toContain("with uncommitted changes");
  });

  test("the report is dated by the local calendar, not UTC", () => {
    expect(localDate(new Date(2026, 9, 13, 23, 30))).toBe("2026-10-13");
  });
});

describe("tool checks", () => {
  test("a missing tool produces a one-line install instruction", () => {
    const problems = toolProblems({ semgrep: null, gitleaks: pins.gitleaks.version }, pins);
    expect(problems).toEqual([
      `semgrep is not installed. Install it with: pipx install semgrep==${pins.semgrep.version}`,
    ]);
    expect(problems[0]).not.toContain("\n");
  });

  test("a tool at another version than CI's pin is reported, so two runs stay comparable", () => {
    const problems = toolProblems({ semgrep: pins.semgrep.version, gitleaks: "8.0.0" }, pins);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(
      `gitleaks 8.0.0 is installed, but CI pins ${pins.gitleaks.version}`
    );
  });

  test("the pinned versions pass", () => {
    expect(
      toolProblems({ semgrep: pins.semgrep.version, gitleaks: pins.gitleaks.version }, pins)
    ).toEqual([]);
  });

  test("CI reads every pin from the shared file instead of repeating it", () => {
    const ci = readFileSync(join(import.meta.dir, "..", ".github", "workflows", "ci.yml"), "utf8");
    for (const key of [
      ".semgrep.version",
      ".semgrep.configs[]",
      ".semgrep.flags[]",
      ".semgrep.targets[]",
      ".gitleaks.version",
      ".gitleaks.linuxSha256",
      ".gitleaks.logOpts",
      ".gitleaks.config",
      ".gitleaks.ignore",
      ".gitleaks.flags[]",
    ]) {
      expect(ci).toContain(key);
    }
    expect(ci).not.toContain(`semgrep==${pins.semgrep.version}`);
    expect(ci).not.toContain(pins.gitleaks.linuxSha256);
  });
});

describe("parsers", () => {
  test("semgrep severities map to the report's scale, and an unknown one is never downgraded", () => {
    const raw = JSON.stringify({
      results: [
        {
          check_id: "a",
          path: "apps/a.ts",
          start: { line: 3 },
          extra: { severity: "ERROR", message: "first line\nmore" },
        },
        {
          check_id: "b",
          path: "apps/b.ts",
          start: { line: 9 },
          extra: { severity: "WARNING", message: "warn" },
        },
        { check_id: "c", path: "apps/c.ts", extra: { severity: "INFO" } },
        { check_id: "d", path: "apps/d.ts", extra: { severity: "CRITICAL" } },
        { check_id: "e", path: "apps/e.ts", extra: { severity: "SOMETHING_NEW" } },
      ],
    });
    expect(semgrepFindings(raw).findings.map((f) => [f.severity, f.location, f.title])).toEqual([
      ["high", "apps/a.ts:3", "first line"],
      ["medium", "apps/b.ts:9", "warn"],
      ["low", "apps/c.ts:0", ""],
      ["critical", "apps/d.ts:0", ""],
      ["high", "apps/e.ts:0", ""],
    ]);
  });

  test("a semgrep message never carries the matched secret", () => {
    const raw = JSON.stringify({
      results: [
        {
          check_id: "secrets-in-config-file",
          path: "apps/x.yaml",
          extra: {
            severity: "ERROR",
            message: `Secrets (${PLACEHOLDER_SECRET}) should not be stored in plain text`,
            metavars: { $VALUE: { abstract_content: PLACEHOLDER_SECRET } },
          },
        },
      ],
    });
    const { findings } = semgrepFindings(raw);
    expect(findings[0]!.title).toBe("Secrets ([redacted]) should not be stored in plain text");
    expect(JSON.stringify(findings)).not.toContain(PLACEHOLDER_SECRET);
    expect(redactMessage("token $TOKEN leaked")).toBe("token [redacted] leaked");
  });

  test("semgrep analysis errors are named by kind and file", () => {
    const raw = JSON.stringify({
      results: [],
      errors: [
        { type: ["PartialParsing", []], path: "packages/x.ts" },
        { type: "Timeout", spans: [{ file: "packages/y.ts" }] },
        { type: "NetworkError" },
      ],
    });
    expect(semgrepFindings(raw).errors).toEqual([
      "PartialParsing in packages/x.ts",
      "Timeout in packages/y.ts",
      "NetworkError",
    ]);
  });

  test("an audit severity outside the known scale stops the run instead of being dropped", () => {
    expect(() => auditFindings({ pkg: [advisory(1, "info")] })).toThrow("unknown severity: info");
  });

  test("an advisory URL with no last segment falls back to its id", () => {
    const [finding] = auditFindings({ pkg: [{ ...advisory(42, "low"), url: "" }] });
    expect(finding!.rule).toBe("42");
  });

  test("the direct dependents are read from bun pm why --top", () => {
    const output =
      "braces@3.0.3\n  ├─ micromatch@4.0.8 (requires ^3.0.3)\n  └─ dev @scope/tool@1.0.0 (requires ~3.0.2)\n";
    expect(directDependents(output)).toEqual(["micromatch", "@scope/tool"]);
  });

  test("gitleaks findings never carry the secret or the matched text", () => {
    const raw = JSON.stringify([
      {
        RuleID: "generic-api-key",
        Description: "Generic API Key",
        File: "apps/x.ts",
        StartLine: 4,
        Commit: "0123456789abcdef",
        Secret: PLACEHOLDER_SECRET,
        Match: `key = ${PLACEHOLDER_SECRET}`,
      },
    ]);
    const findings = gitleaksFindings(raw);
    expect(findings).toEqual([
      {
        tool: "gitleaks",
        severity: "high",
        rule: "generic-api-key",
        location: "apps/x.ts:4 @ 0123456",
        title: "Generic API Key",
      },
    ]);
    expect(JSON.stringify(findings)).not.toContain(PLACEHOLDER_SECRET);
    expect(gitleaksFindings("")).toEqual([]);
  });
});
