import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "../..");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

test("the site publishes exactly two .well-known files: security.txt and stellar.toml", () => {
  expect(
    walk(join(ROOT, "public/.well-known"))
      .map((f) => relative(ROOT, f))
      .sort()
  ).toEqual(["public/.well-known/security.txt", "public/.well-known/stellar.toml"]);
});

test("no app route serves anything under .well-known", () => {
  const routes = walk(join(ROOT, "app")).filter((f) => f.includes(".well-known"));
  expect(routes).toEqual([]);
});
