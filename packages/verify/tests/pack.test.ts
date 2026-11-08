/** What `npm publish` would ship: the bundle, the vectors, the README, changelog and licence. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { checkPackList, PACK_ALLOWLIST } from "../scripts/pack-check";

const root = new URL("..", import.meta.url).pathname;

test("the package tarball lists only files on the allowlist", () => {
  const run = Bun.spawnSync(["npm", "pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
  });
  expect(run.exitCode).toBe(0);
  const [pack] = JSON.parse(run.stdout.toString()) as [{ files: { path: string }[] }];
  const files = pack.files.map((f) => f.path).sort();

  // `test` builds the JavaScript only; the declarations come from `build`, which pack:check needs.
  for (const required of PACK_ALLOWLIST.filter(
    (f) => !f.endsWith(".d.ts") && !f.endsWith(".d.cts")
  )) {
    expect(files).toContain(required);
  }
  const allowed = new Set<string>(PACK_ALLOWLIST);
  expect(files.filter((path) => !allowed.has(path))).toEqual([]);
});

test("LICENSE is a byte-for-byte copy of the repository's LICENSE", () => {
  const repository = readFileSync(`${root}../../LICENSE`);
  const copy = readFileSync(`${root}LICENSE`);
  expect(copy.equals(repository)).toBe(true);
});

test("checkPackList wants every allowlisted file, once, and nothing else", () => {
  expect(checkPackList([...PACK_ALLOWLIST].reverse())).toEqual([]);
  for (const file of ["LICENSE", "CHANGELOG.md", "dist/index.d.cts", "vectors/close-v1.json"]) {
    expect(checkPackList(PACK_ALLOWLIST.filter((f) => f !== file))).toEqual([
      `missing from the tarball: ${file}`,
    ]);
  }
  expect(checkPackList([...PACK_ALLOWLIST, "src/index.ts"])).toEqual([
    "not on the allowlist: src/index.ts",
  ]);
  expect(checkPackList([...PACK_ALLOWLIST, "LICENSE"])).toEqual(["the tarball lists a file twice"]);
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
    expect(PACK_ALLOWLIST as readonly string[]).toContain(target.slice("./".length));
  }
  // The SDK is a peer, never a dependency that would install a second copy.
  expect(manifest.dependencies).toBeUndefined();
  expect(Object.keys(manifest.peerDependencies)).toEqual(["@stellar/stellar-sdk"]);
});
