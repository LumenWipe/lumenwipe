import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate, linePercent, parseLcov, summary, type Thresholds } from "./coverage-gate";

const LCOV = [
  "TN:",
  "SF:src/lib/stellar/submit.ts",
  "FNF:12",
  "FNH:11",
  "DA:1,1",
  "LF:119",
  "LH:117",
  "end_of_record",
  "SF:src/lib/stellar/tx-builder/merge.ts",
  "LF:40",
  "LH:40",
  "end_of_record",
  "SF:src/lib/stellar/tx-builder/close-operations.ts",
  "LF:58",
  "LH:55",
  "end_of_record",
  "SF:src/types.ts",
  "LF:0",
  "LH:0",
  "end_of_record",
  "",
].join("\n");

const coverage = parseLcov(LCOV);

test("reads the line counts of each file in an lcov report", () => {
  expect(coverage.get("src/lib/stellar/submit.ts")).toEqual({ found: 119, hit: 117 });
  expect(coverage.size).toBe(4);
});

test("a file with no executable line counts as fully covered", () => {
  expect(linePercent({ found: 0, hit: 0 })).toBe(100);
  expect(linePercent({ found: 58, hit: 55 })).toBeCloseTo(94.83, 2);
});

test("a file at its threshold passes and one below it fails", () => {
  expect(evaluate(coverage, { "src/lib/stellar/submit.ts": 98 }).errors).toEqual([]);
  const below = evaluate(coverage, { "src/lib/stellar/submit.ts": 99 });
  expect(below.errors).toEqual([
    "src/lib/stellar/submit.ts: 98.32% of lines covered, below its 99% gate.",
  ]);
  expect(below.rows[0]).toMatchObject({ pass: false, threshold: 99 });
});

test("a gated file missing from the report fails", () => {
  expect(evaluate(coverage, { "src/lib/stellar/signature.ts": 50 }).errors).toEqual([
    "src/lib/stellar/signature.ts is gated at 50% but is not in the coverage report.",
  ]);
});

test("a directory key gates every file under it that has no key of its own", () => {
  const verdict = evaluate(coverage, {
    "src/lib/stellar/tx-builder/": 100,
    "src/lib/stellar/tx-builder/close-operations.ts": 90,
  });
  expect(verdict.errors).toEqual([]);
  expect(verdict.rows.map((row) => [row.file, row.threshold])).toEqual([
    ["src/lib/stellar/tx-builder/merge.ts", 100],
    ["src/lib/stellar/tx-builder/close-operations.ts", 90],
  ]);
  expect(evaluate(coverage, { "src/lib/stellar/tx-builder/": 100 }).errors).toHaveLength(1);
  expect(evaluate(coverage, { "src/lib/missing/": 100 }).errors).toHaveLength(1);
});

test("the summary lists each gated file and every failure", () => {
  const text = summary("apps/api", evaluate(coverage, { "src/lib/stellar/submit.ts": 99 }));
  expect(text).toContain("| `src/lib/stellar/submit.ts` | 98.32% | 99% | FAIL |");
  expect(text).toContain("- src/lib/stellar/submit.ts: 98.32% of lines covered");
});

test("every configured workspace has a coverage:gate script and only whole-number gates", () => {
  const root = join(import.meta.dir, "..");
  const thresholds = JSON.parse(
    readFileSync(join(root, "scripts/coverage-thresholds.json"), "utf8")
  ) as Thresholds;
  for (const [workspace, files] of Object.entries(thresholds)) {
    const scripts = JSON.parse(readFileSync(join(root, workspace, "package.json"), "utf8"))
      .scripts as Record<string, string>;
    expect(scripts["coverage:gate"]).toBe("bun ../../scripts/coverage-gate.ts");
    expect(scripts["test:coverage"]).toContain("--coverage-reporter=lcov");
    for (const threshold of Object.values(files)) {
      expect(threshold % 5).toBe(0);
      expect(threshold).toBeLessThanOrEqual(100);
    }
  }
});
