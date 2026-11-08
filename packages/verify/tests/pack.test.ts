/** What `npm publish` would ship: the bundle, the vectors and the README, and nothing else. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;

test("the package tarball lists dist, the vectors and the README only", () => {
  const run = Bun.spawnSync(["npm", "pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
  });
  expect(run.exitCode).toBe(0);
  const [pack] = JSON.parse(run.stdout.toString()) as [{ files: { path: string }[] }];
  const files = pack.files.map((f) => f.path).sort();

  for (const required of [
    "README.md",
    "dist/index.cjs",
    "dist/index.js",
    "package.json",
    "vectors/close-v1.json",
  ]) {
    expect(files).toContain(required);
  }
  const allowed = (path: string) =>
    path === "README.md" ||
    path === "package.json" ||
    /^dist\/index\.(?:js|cjs|d\.ts|d\.cts)$/.test(path) ||
    path === "vectors/close-v1.json";
  expect(files.filter((path) => !allowed(path))).toEqual([]);
});

test("every export target is inside the packed files", () => {
  const manifest = JSON.parse(readFileSync(`${root}package.json`, "utf8")) as {
    files: string[];
    exports: Record<string, string | Record<string, Record<string, string>>>;
    peerDependencies: Record<string, string>;
    dependencies?: Record<string, string>;
  };
  const targets: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string") targets.push(node);
    else if (node && typeof node === "object") Object.values(node).forEach(walk);
  };
  walk(manifest.exports);
  for (const target of targets) {
    expect(manifest.files.some((dir) => target.startsWith(`./${dir}`))).toBe(true);
  }
  // The SDK is a peer, never a dependency that would install a second copy.
  expect(manifest.dependencies).toBeUndefined();
  expect(Object.keys(manifest.peerDependencies)).toEqual(["@stellar/stellar-sdk"]);
});
