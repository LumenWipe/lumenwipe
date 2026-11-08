// Packs the verifier the way npm publishes it and checks the tarball: the exact file list, publint
// and attw. Run after `build`. The bundle itself is checked by the package tests, in both module
// formats. Prints the tarball path; with PACK_OUT_DIR set the tarball is written there, and under
// GitHub Actions its path is also the `tarball` step output.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Every file the published tarball may contain, and must contain. */
export const PACK_ALLOWLIST = [
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "dist/index.cjs",
  "dist/index.d.cts",
  "dist/index.d.ts",
  "dist/index.js",
  "package.json",
  "vectors/close-v1.json",
] as const;

export function checkPackList(files: readonly string[]): string[] {
  const problems: string[] = [];
  const allowed = new Set<string>(PACK_ALLOWLIST);
  const present = new Set(files);
  for (const file of PACK_ALLOWLIST) {
    if (!present.has(file)) problems.push(`missing from the tarball: ${file}`);
  }
  for (const file of files) {
    if (!allowed.has(file)) problems.push(`not on the allowlist: ${file}`);
  }
  if (present.size !== files.length) problems.push("the tarball lists a file twice");
  return problems;
}

const VERIFY = resolve(import.meta.dir, "..");

function run(command: string, args: string[], cwd: string): string {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string };
    throw new Error(
      `${[command, ...args].join(" ")} failed in ${cwd}\n${failed.stdout ?? ""}${failed.stderr ?? ""}`,
      { cause: error }
    );
  }
}

/** The JS file a dependency's bin points at, run with node so its own shebang does not matter. */
function binOf(pkg: string, bin: string): string {
  const manifestPath = Bun.resolveSync(`${pkg}/package.json`, VERIFY);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const target = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[bin];
  if (!target) throw new Error(`${pkg} has no ${bin} bin`);
  return join(dirname(manifestPath), target);
}

function main(): void {
  const work = mkdtempSync(join(tmpdir(), "verify-pack-"));
  const outDir = process.env.PACK_OUT_DIR ? resolve(process.env.PACK_OUT_DIR) : join(work, "pack");
  mkdirSync(outDir, { recursive: true });

  console.log("- npm pack");
  const [packed] = JSON.parse(
    run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", outDir], VERIFY)
  ) as { filename: string; files: { path: string }[] }[];
  const tarball = join(outDir, packed.filename);
  const problems = checkPackList(packed.files.map((f) => f.path));
  if (problems.length > 0) throw new Error(problems.join("\n"));

  console.log("- publint");
  run("node", [binOf("publint", "publint"), "run", tarball, "--strict"], work);

  console.log("- attw");
  run("node", [binOf("@arethetypeswrong/cli", "attw"), tarball, "--format", "ascii"], work);

  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tarball=${tarball}\n`);
  console.log(`Packed tarball: ${tarball}`);
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
