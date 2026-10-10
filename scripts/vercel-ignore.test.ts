import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { decide, shouldBuild, WATCHED } from "./vercel-ignore.mjs";

const BASE = "a".repeat(40);
const run = (app: string, files: string[]): boolean => decide(app, BASE, () => files).build;

describe("web", () => {
  test.each([
    "apps/web/app/page.tsx",
    "packages/sdk/src/index.ts",
    "packages/types/src/index.ts",
    "apps/api/src/config/exchange-registry.json",
    "bun.lock",
    "package.json",
    "tsconfig.base.json",
  ])("builds when %s changes", (file) => {
    expect(run("web", [file])).toBe(true);
  });

  test.each([
    "apps/api/src/close/builder.ts",
    "apps/playground/app/page.tsx",
    "docs/architecture.md",
    ".github/workflows/ci.yml",
    "scripts/vercel-ignore.mjs",
    "README.md",
  ])("skips when only %s changes", (file) => {
    expect(run("web", [file])).toBe(false);
  });
});

describe("playground", () => {
  test.each([
    "apps/playground/lib/demolish.ts",
    "packages/sdk/src/index.ts",
    "packages/types/src/index.ts",
    "bun.lock",
    "package.json",
  ])("builds when %s changes", (file) => {
    expect(run("playground", [file])).toBe(true);
  });

  test.each([
    "apps/web/app/page.tsx",
    "apps/api/src/config/exchange-registry.json",
    "apps/api/src/close/builder.ts",
    "docs/architecture.md",
  ])("skips when only %s changes", (file) => {
    expect(run("playground", [file])).toBe(false);
  });
});

describe("path matching", () => {
  test("does not match sibling directories that share a prefix", () => {
    expect(shouldBuild("web", ["apps/web-extra/a.ts", "packages/sdk-foo/a.ts"])).toBe(false);
    expect(shouldBuild("web", ["package.json.bak"])).toBe(false);
  });

  test("builds when any one file in a mixed list matches", () => {
    expect(run("web", ["docs/a.md", "apps/api/src/x.ts", "packages/types/src/a.ts"])).toBe(true);
  });
});

describe("fail open", () => {
  const noDiff = (): string[] => {
    throw new Error("diff must not run");
  };

  test.each([undefined, "", "0".repeat(40), "main", "abc123"])("builds for base %p", (base) => {
    expect(decide("web", base, noDiff).build).toBe(true);
  });

  test("builds when git cannot compare", () => {
    const result = decide("web", BASE, () => {
      throw new Error("bad object");
    });
    expect(result.build).toBe(true);
  });

  test("builds on an empty diff", () => {
    expect(decide("web", BASE, () => []).build).toBe(true);
  });

  test("builds for an unknown app", () => {
    expect(decide("nope", BASE, () => ["docs/a.md"]).build).toBe(true);
  });
});

describe("vercel.json", () => {
  test.each(Object.keys(WATCHED))("%s project runs the script for its own app", (app) => {
    const config = JSON.parse(readFileSync(`apps/${app}/vercel.json`, "utf8"));
    expect(config.ignoreCommand).toBe(`node ../../scripts/vercel-ignore.mjs ${app}`);
  });
});
