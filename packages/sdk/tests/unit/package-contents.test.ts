import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkPackList, MINIMUM_TYPESCRIPT, PACK_ALLOWLIST } from "../../scripts/pack-check";

const SDK = join(import.meta.dir, "../..");
const manifest = JSON.parse(readFileSync(join(SDK, "package.json"), "utf8")) as {
  files: string[];
  sideEffects: boolean;
  engines: { node: string };
  main: string;
  module: string;
  types: string;
  exports: Record<string, Record<string, Record<string, string>>>;
  devDependencies: Record<string, string>;
};

describe("published package contents", () => {
  test("LICENSE is a byte-for-byte copy of the repository's LICENSE", () => {
    const root = readFileSync(join(SDK, "../../LICENSE"));
    const copy = readFileSync(join(SDK, "LICENSE"));
    expect(copy.equals(root)).toBe(true);
  });

  test("the allowlist passes as is, in any order", () => {
    expect(checkPackList([...PACK_ALLOWLIST].reverse())).toEqual([]);
  });

  test("a missing LICENSE or CHANGELOG fails", () => {
    for (const file of ["LICENSE", "CHANGELOG.md", "README.md", "dist/index.d.cts"]) {
      const files = PACK_ALLOWLIST.filter((f) => f !== file);
      expect(checkPackList(files)).toEqual([`missing from the tarball: ${file}`]);
    }
  });

  test("an extra file fails", () => {
    expect(checkPackList([...PACK_ALLOWLIST, "dist/index.js.map"])).toEqual([
      "not on the allowlist: dist/index.js.map",
    ]);
    expect(checkPackList([...PACK_ALLOWLIST, "src/index.ts"])).toEqual([
      "not on the allowlist: src/index.ts",
    ]);
  });

  test("a duplicated file fails", () => {
    expect(checkPackList([...PACK_ALLOWLIST, "LICENSE"])).toEqual([
      "the tarball lists a file twice",
    ]);
  });

  test("package.json ships the files the allowlist expects and declares its runtime", () => {
    expect(manifest.files.sort()).toEqual(["CHANGELOG.md", "LICENSE", "README.md", "dist"]);
    expect(manifest.sideEffects).toBe(false);
    expect(manifest.engines).toEqual({ node: ">=22" });
  });

  test("every entry point is on the allowlist", () => {
    const targets = [manifest.main, manifest.module, manifest.types];
    for (const condition of Object.values(manifest.exports["."])) {
      targets.push(...Object.values(condition));
    }
    for (const target of targets) {
      expect(PACK_ALLOWLIST as readonly string[]).toContain(target.replace(/^\.\//, ""));
    }
  });

  test("the minimum TypeScript is the pinned one and the one the docs name", () => {
    const pinned = manifest.devDependencies["typescript-minimum"];
    expect(pinned.startsWith(`npm:typescript@${MINIMUM_TYPESCRIPT}.`)).toBe(true);
    const readme = readFileSync(join(SDK, "README.md"), "utf8");
    const docs = readFileSync(join(SDK, "../../docs/sdk/versioning.mdx"), "utf8");
    for (const text of [readme, docs]) {
      expect(text).toContain(`TypeScript ${MINIMUM_TYPESCRIPT} or later`);
      expect(text).toContain("Node.js 22 or later");
    }
  });
});
