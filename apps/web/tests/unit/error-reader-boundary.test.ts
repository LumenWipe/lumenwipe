import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const WEB_ROOT = join(import.meta.dir, "..", "..");
const SCAN_DIRS = ["app", "components", "hooks", "lib", "store"];
const READER = "lib/utils/user-error.ts";
const SECOND_READERS = /\b(apiErrorMessage|looksPlain|translateRpcError|extractResultCode)\b/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

test("API and wallet error text is read only through the shared reader in user-error.ts", () => {
  const offenders = SCAN_DIRS.flatMap((dir) => sourceFiles(join(WEB_ROOT, dir)))
    .map((path) => relative(WEB_ROOT, path))
    .filter((path) => path !== READER)
    .filter((path) => SECOND_READERS.test(readFileSync(join(WEB_ROOT, path), "utf8")));
  expect(offenders).toEqual([]);
});
