import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// The build must not depend on a font host: every font is a file under app/fonts,
// loaded with next/font/local.
const APP = join(import.meta.dir, "..", "..");
const SKIPPED = new Set([
  "node_modules",
  ".next",
  ".vercel",
  ".stryker-tmp",
  "coverage",
  "reports",
  "playwright-report",
  "test-results",
  "lighthouse-report",
]);
const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|css|mdx)$/;
// The module specifier in quotes, so prose that names the loader does not count.
const GOOGLE_FONTS = new RegExp(`["'\`]${["next", "font", "google"].join("/")}["'\`]`);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIPPED.has(entry.name)) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return SOURCE.test(entry.name) ? [path] : [];
  });
}

describe("self-hosted fonts", () => {
  test("no source file imports from next/font's Google loader", () => {
    const offenders = sources(APP)
      .filter((file) => GOOGLE_FONTS.test(readFileSync(file, "utf8")))
      .map((file) => relative(APP, file));
    expect(offenders).toEqual([]);
  });

  test("every font app/fonts.ts loads is a committed file under app/fonts", () => {
    const fonts = readFileSync(join(APP, "app", "fonts.ts"), "utf8");
    expect(fonts).toContain('from "next/font/local"');
    const files = [...fonts.matchAll(/src: "\.\/(fonts\/[^"]+\.woff2)"/g)].map((m) => m[1]!);
    expect(files).toHaveLength(3);
    for (const file of files) expect(existsSync(join(APP, "app", file))).toBe(true);
  });

  test("the font folder carries the licence and the provenance note", () => {
    for (const file of ["OFL.txt", "README.md"]) {
      expect(existsSync(join(APP, "app", "fonts", file))).toBe(true);
    }
  });
});
