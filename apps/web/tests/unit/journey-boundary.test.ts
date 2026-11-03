import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { DemolishPhase } from "@/types/plan";

// Only lib/journey may turn a phase into a decision: everywhere else reads the journey state, so
// no screen can make a claim from a phase string the journey would not allow.

const WEB = join(import.meta.dir, "..", "..");
const SCANNED = ["app", "components", "hooks", "lib", "store"];
const EXEMPT = join(WEB, "lib", "journey");

const PHASES = Object.keys({
  IDLE: true,
  ANALYZING: true,
  PREFLIGHT_COMPLETE: true,
  SIGNER_SETUP: true,
  STEP_EXECUTING: true,
  STEP_CONFIRMED: true,
  STEP_FAILED: true,
  STEP_UNCONFIRMED: true,
  COMPLETE: true,
  ABORTED: true,
} satisfies Record<DemolishPhase, true>).join("|");

const RULES: Array<[string, RegExp]> = [
  ["phase compared with a string", /\b[\w.]*phase\s*[!=]==?\s*["'`]/i],
  ["phase literal compared", new RegExp(`["'\`](?:${PHASES})["'\`]\\s*[!=]==?`)],
  ["phase looked up in a list", /\.includes\(\s*[\w.]*phase\s*\)/i],
  ["switch on a phase", /\bswitch\s*\(\s*[\w.]*phase\s*\)/i],
  ["case on a phase literal", new RegExp(`\\bcase\\s+["'\`](?:${PHASES})["'\`]`)],
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (path === EXEMPT) return [];
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Source without its comments, so prose about phases is not read as code. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\w])\/\/.*$/gm, "$1");
}

function phaseDecisions(source: string): string[] {
  const code = withoutComments(source);
  return RULES.filter(([, rule]) => rule.test(code)).map(([name]) => name);
}

describe("phase decisions stay in lib/journey", () => {
  const files = SCANNED.flatMap((dir) => sourceFiles(join(WEB, dir)));

  test("the scan reads the screens", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  test.each(files.map((f) => relative(WEB, f)))("%s decides nothing from a phase", (file) => {
    expect(phaseDecisions(readFileSync(join(WEB, file), "utf8"))).toEqual([]);
  });

  test.each([
    ['if (phase === "COMPLETE") go();', "phase compared with a string"],
    ['const done = state.phase !== "STEP_FAILED";', "phase compared with a string"],
    ['if ("COMPLETE" === current) go();', "phase literal compared"],
    ["const early = PRE_SIGNING.includes(phase);", "phase looked up in a list"],
    ["switch (phase) {}", "switch on a phase"],
    ['switch (kind) { case "STEP_FAILED": break; }', "case on a phase literal"],
  ])("catches %s", (code, rule) => {
    expect(phaseDecisions(code)).toContain(rule);
  });

  test("ignores a phase named in a comment and a phase being set", () => {
    expect(phaseDecisions('// phase === "COMPLETE"\nsetPhase("COMPLETE");')).toEqual([]);
  });
});
