import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkoutRoot } from "../src/home";

const LAB_CHECKS = new Set(["type-check", "lint", "test"]);

const RUNS_THE_LAB: readonly RegExp[] = [
  /\blab\s+(measure|e2e)\b/,
  /\brun\s+lab\b/,
  /@lumenwipe\/lab['"]?\s+['"]?lab\b/,
  /tools\/lab\/src\b/,
  /\bcd\s+tools\/lab\b/,
  /\bsrc\/cli\.ts\b/,
  /\bLUMENWIPE_LAB_/,
  /--filter\s+\S+\s+['"]?lab['"]?(\s|$)/m,
];

/** Every matrix entry for the lab package, wherever it sits and however it is wrapped. */
function labMatrixEntries(node: unknown): Record<string, unknown>[] {
  if (Array.isArray(node)) return node.flatMap(labMatrixEntries);
  if (typeof node !== "object" || node === null) return [];
  const entry = node as Record<string, unknown>;
  const own = entry.pkg === "@lumenwipe/lab" ? [entry] : [];
  return [...own, ...Object.values(entry).flatMap(labMatrixEntries)];
}

/** What in a workflow would run the lab rather than its tests. */
function labInvocations(text: string): string[] {
  const found = RUNS_THE_LAB.filter((re) => re.test(text)).map(String);
  for (const entry of labMatrixEntries(Bun.YAML.parse(text))) {
    for (const check of String(entry.checks ?? "")
      .split(/\s+/)
      .filter(Boolean)) {
      if (!LAB_CHECKS.has(check)) found.push(`matrix check ${check}`);
    }
  }
  return found;
}

describe("no workflow runs the lab", () => {
  const dir = join(checkoutRoot(), ".github", "workflows");
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));

  test("finds the workflows", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    test(file, () => {
      expect(labInvocations(readFileSync(join(dir, file), "utf8"))).toEqual([]);
    });
  }

  test("the check catches every way of running it", () => {
    for (const text of [
      "run: bun run lab measure --target local",
      "run: cd tools/lab && bun src/cli.ts e2e",
      "run: bun run --filter '@lumenwipe/lab' lab",
      "run: bun tools/lab/src/cli.ts",
      "env:\n  LUMENWIPE_LAB_API_KEY: ${{ secrets.KEY }}",
      'include:\n  - { name: "lab", pkg: "@lumenwipe/lab", checks: "type-check lab" }',
      'include:\n  - {\n      name: "lab",\n      pkg: "@lumenwipe/lab",\n      checks: "type-check lint test lab",\n    }',
      "run: bun run --filter '*' lab",
      "run: bun run --filter './tools/*' lab --target local",
    ]) {
      expect(labInvocations(text)).not.toEqual([]);
    }
    expect(
      labInvocations(
        'include:\n  - { name: "lab", pkg: "@lumenwipe/lab", checks: "type-check lint test" }'
      )
    ).toEqual([]);
  });
});
