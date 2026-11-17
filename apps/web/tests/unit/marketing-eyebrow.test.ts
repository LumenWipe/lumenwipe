import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const WEB_ROOT = join(import.meta.dir, "..", "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return name.endsWith(".tsx") ? [full] : [];
  });
}

// A decorative rule before a section label is static, so it takes a neutral line, never cyan.
const ACCENT_RULE = /className="h-px w-\d+ bg-accent\b/;
// The label itself is static text too, so it is never set in the interactive color.
const ACCENT_LABEL = /className="[^"]*\bmkt-eyebrow\b[^"]*\btext-accent\b/;

function offenders(pattern: RegExp): string[] {
  return ["app", "components"]
    .flatMap((dir) => sources(join(WEB_ROOT, dir)))
    .filter((file) => pattern.test(readFileSync(file, "utf8")))
    .map((file) => relative(WEB_ROOT, file));
}

test("no section label rule is drawn in the interactive color", () => {
  expect(offenders(ACCENT_RULE)).toEqual([]);
});

test("no section label is set in the interactive color", () => {
  expect(offenders(ACCENT_LABEL)).toEqual([]);
});

test("the check catches an accent rule", () => {
  expect(ACCENT_RULE.test(`<span className="h-px w-6 bg-accent/50" />`)).toBe(true);
  expect(ACCENT_RULE.test(`<span className="h-px w-6 bg-line-strong" />`)).toBe(false);
});

test("the check catches an accent label", () => {
  expect(ACCENT_LABEL.test(`<span className="mkt-eyebrow inline-flex text-accent/90">`)).toBe(true);
  expect(ACCENT_LABEL.test(`<p className="mkt-eyebrow mb-3 text-accent">`)).toBe(true);
  expect(ACCENT_LABEL.test(`<span className="mkt-eyebrow text-fg-muted">`)).toBe(false);
});
