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

test("no section label rule is drawn in the interactive color", () => {
  const found = ["app", "components"]
    .flatMap((dir) => sources(join(WEB_ROOT, dir)))
    .filter((file) => ACCENT_RULE.test(readFileSync(file, "utf8")))
    .map((file) => relative(WEB_ROOT, file));
  expect(found).toEqual([]);
});

test("the check catches an accent rule", () => {
  expect(ACCENT_RULE.test(`<span className="h-px w-6 bg-accent/50" />`)).toBe(true);
  expect(ACCENT_RULE.test(`<span className="h-px w-6 bg-line-strong" />`)).toBe(false);
});
