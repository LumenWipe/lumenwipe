import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "../..");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

test("the static .well-known files are exactly security.txt and stellar.toml", () => {
  expect(
    walk(join(ROOT, "public/.well-known"))
      .map((f) => relative(ROOT, f))
      .sort()
  ).toEqual(["public/.well-known/security.txt", "public/.well-known/stellar.toml"]);
});

test("the app routes under .well-known are exactly the agent discovery files", () => {
  expect(
    walk(join(ROOT, "app"))
      .filter((f) => f.includes(".well-known"))
      .map((f) => relative(join(ROOT, "app"), f))
      .sort()
  ).toEqual([
    ".well-known/agent-skills/[skill]/SKILL.md/route.ts",
    ".well-known/agent-skills/index.json/route.ts",
    ".well-known/ai-catalog.json/route.ts",
    ".well-known/ard.json/route.ts",
  ]);
});

test("no static file shadows a generated discovery file", () => {
  for (const path of ["auth.md", ".well-known/ard.json", ".well-known/ai-catalog.json"]) {
    expect(existsSync(join(ROOT, "public", path))).toBe(false);
  }
  expect(existsSync(join(ROOT, "public/.well-known/agent-skills"))).toBe(false);
});
