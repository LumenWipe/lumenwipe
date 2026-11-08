/**
 * Checks apps/web/.env.example against the variables the web app reads, in both directions:
 * every variable read is in the template, and every template entry is read somewhere.
 *
 *   bun scripts/check-env-template.ts
 *
 * Tests and these scripts are not scanned: they are not the app, and what they read is theirs.
 */
import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Set by the runtime or the CI host, never by whoever fills in the template. */
export const PLATFORM_VARIABLES: ReadonlyMap<string, string> = new Map([
  ["NODE_ENV", "set by Next.js for each command"],
  ["VERCEL_ENV", "set by Vercel on every deployment"],
  ["CI", "set by the CI runner"],
]);

const WEB_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SKIPPED_DIRS = new Set(["node_modules", ".next", "coverage", "tests", "scripts"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const READ = /process\.env(?:\.([A-Z_][A-Z0-9_]*)|\[\s*["']([A-Z_][A-Z0-9_]*)["']\s*\])/g;
const ENTRY = /^([A-Z_][A-Z0-9_]*)=/;

/** The variables one source file reads through `process.env`. */
export function readsIn(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(READ)) names.add((match[1] ?? match[2])!);
  return names;
}

/** The variables a template defines: every uncommented `NAME=` line. */
export function templateEntries(template: string): Set<string> {
  const names = new Set<string>();
  for (const line of template.split("\n")) {
    const match = ENTRY.exec(line);
    if (match) names.add(match[1]!);
  }
  return names;
}

/** One message per variable the template and the code disagree on, or none. */
export function envTemplateDrift({
  reads,
  template,
  platform = PLATFORM_VARIABLES,
}: {
  reads: ReadonlySet<string>;
  template: ReadonlySet<string>;
  platform?: ReadonlyMap<string, string>;
}): string[] {
  const drift: string[] = [];
  for (const name of [...reads].sort()) {
    if (!template.has(name) && !platform.has(name)) {
      drift.push(`${name} is read by the web app but missing from .env.example`);
    }
  }
  for (const name of [...template].sort()) {
    if (!reads.has(name)) drift.push(`${name} is in .env.example but the web app never reads it`);
  }
  return drift;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory())
      return SKIPPED_DIRS.has(entry.name) ? [] : sourceFiles(join(dir, entry.name));
    return SOURCE_EXTENSIONS.has(extname(entry.name)) ? [join(dir, entry.name)] : [];
  });
}

/** The drift between the web app's sources and its template, as checked out. */
export function webEnvTemplateDrift(root = WEB_ROOT): string[] {
  const reads = new Set<string>();
  for (const file of sourceFiles(root)) {
    for (const name of readsIn(readFileSync(file, "utf8"))) reads.add(name);
  }
  const template = templateEntries(readFileSync(join(root, ".env.example"), "utf8"));
  return envTemplateDrift({ reads, template });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const drift = webEnvTemplateDrift();
  for (const line of drift) process.stderr.write(`${line}\n`);
  if (drift.length > 0) process.exit(1);
  process.stdout.write("apps/web/.env.example matches the variables the web app reads.\n");
}
