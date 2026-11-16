// Per-file line coverage gate for the trust-boundary modules. Reads the lcov report a workspace's
// `test:coverage` wrote and holds each file listed for that workspace in
// scripts/coverage-thresholds.json to its minimum. A key ending in "/" holds every reported file
// under it that has no key of its own. A listed file missing from the report fails too: a module no test loads has no coverage.
// Prints the gated files as a Markdown table, also into the CI job summary when there is one.
// Usage, from a workspace: bun ../../scripts/coverage-gate.ts
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export type Thresholds = Record<string, Record<string, number>>;

export interface FileCoverage {
  found: number;
  hit: number;
}

export interface Row {
  file: string;
  lines: number;
  threshold: number;
  pass: boolean;
}

export interface Verdict {
  rows: Row[];
  errors: string[];
}

/** Line counts per source file (LF and LH) from an lcov report. */
export function parseLcov(text: string): Map<string, FileCoverage> {
  const files = new Map<string, FileCoverage>();
  let file: string | null = null;
  let found = 0;
  let hit = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) {
      file = line.slice(3).trim();
      found = 0;
      hit = 0;
    } else if (line.startsWith("LF:")) {
      found = Number(line.slice(3));
    } else if (line.startsWith("LH:")) {
      hit = Number(line.slice(3));
    } else if (line.trim() === "end_of_record" && file !== null) {
      files.set(file, { found, hit });
      file = null;
    }
  }
  return files;
}

/** A file with no executable line counts as fully covered. */
export function linePercent({ found, hit }: FileCoverage): number {
  return found === 0 ? 100 : (hit / found) * 100;
}

export function evaluate(
  coverage: Map<string, FileCoverage>,
  thresholds: Record<string, number>
): Verdict {
  const rows: Row[] = [];
  const errors: string[] = [];
  for (const [key, threshold] of Object.entries(thresholds)) {
    const files = key.endsWith("/")
      ? [...coverage.keys()]
          .filter((file) => file.startsWith(key) && !Object.hasOwn(thresholds, file))
          .sort()
      : coverage.has(key)
        ? [key]
        : [];
    if (files.length === 0) {
      errors.push(`${key} is gated at ${threshold}% but is not in the coverage report.`);
      continue;
    }
    for (const file of files) {
      const lines = linePercent(coverage.get(file)!);
      const pass = lines >= threshold;
      rows.push({ file, lines, threshold, pass });
      if (!pass) {
        errors.push(
          `${file}: ${lines.toFixed(2)}% of lines covered, below its ${threshold}% gate.`
        );
      }
    }
  }
  return { rows, errors };
}

export function summary(workspace: string, verdict: Verdict): string {
  const lines = [
    `### Coverage of the gated files in ${workspace}`,
    "",
    "| File | Lines | Gate | Result |",
    "| --- | ---: | ---: | --- |",
    ...verdict.rows.map(
      (row) =>
        `| \`${row.file}\` | ${row.lines.toFixed(2)}% | ${row.threshold}% | ${row.pass ? "pass" : "FAIL"} |`
    ),
  ];
  if (verdict.errors.length > 0) lines.push("", ...verdict.errors.map((error) => `- ${error}`));
  return `${lines.join("\n")}\n`;
}

function main(): number {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const workspace = relative(root, process.cwd());
  const all = JSON.parse(
    readFileSync(join(root, "scripts/coverage-thresholds.json"), "utf8")
  ) as Thresholds;
  const thresholds = all[workspace];
  if (!thresholds) {
    console.error(`No coverage gate is configured for ${workspace}.`);
    return 1;
  }
  const report = join(process.cwd(), "coverage/lcov.info");
  if (!existsSync(report)) {
    console.error(`${report} is missing. Run test:coverage first.`);
    return 1;
  }
  const verdict = evaluate(parseLcov(readFileSync(report, "utf8")), thresholds);
  const text = summary(workspace, verdict);
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  return verdict.errors.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(main());
