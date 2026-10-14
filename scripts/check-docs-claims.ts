import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export interface Problem {
  source: string;
  message: string;
}

const REGISTER = "docs/invariants.mdx";
const THREAT_MODEL = "docs/threat-model.md";
const CLAUDE_MD = "CLAUDE.md";
const CI_WORKFLOW = ".github/workflows/ci.yml";
const SKIPPED_DIRS = new Set(["node_modules", ".next", "dist", "coverage", ".turbo", "out"]);
const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

function read(root: string, path: string): string | null {
  const full = join(root, path);
  return existsSync(full) && statSync(full).isFile() ? readFileSync(full, "utf8") : null;
}

function walk(root: string, dir: string, skip: (path: string) => boolean): string[] {
  const full = join(root, dir);
  if (!existsSync(full)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name) && !skip(path)) files.push(...walk(root, path, skip));
    } else if (SOURCE_FILE.test(entry.name) && !skip(path)) {
      files.push(path);
    }
  }
  return files;
}

export function codeSpans(text: string): string[] {
  return [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!);
}

export function expandBraces(path: string): string[] {
  const match = /\{([^{}]+)\}/.exec(path);
  if (!match) return [path];
  const [whole, options] = match;
  return options!.split(",").flatMap((option) => expandBraces(path.replace(whole, option)));
}

function looksLikePath(span: string): boolean {
  return /^\.?[\w@-][\w@.{},-]*(\/[\w@.{},-]+)+\/?$/.test(span);
}

function section(text: string, heading: RegExp): string | null {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return null;
  const end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

function hasYamlJob(source: string, job: string): boolean {
  return new RegExp(`^  ${job.replace(/[-]/g, "\\-")}:\\s*$`, "m").test(source);
}

function hasTestName(source: string, name: string): boolean {
  return [`"${name}"`, `'${name}'`, `\`${name}\``].some((quoted) => source.includes(quoted));
}

/**
 * A register reference is a code span of the form `path`, `path#symbol` or `path#"test name"`.
 * The path must exist; a symbol must appear in the file as a whole word (a job key for a
 * workflow file); a test name must appear in the file as a string literal.
 */
export function checkRegister(root: string): Problem[] {
  const text = read(root, REGISTER);
  if (text === null) return [{ source: REGISTER, message: "the invariant register is missing" }];
  const problems: Problem[] = [];
  for (const span of codeSpans(text)) {
    const hash = span.indexOf("#");
    const path = hash === -1 ? span : span.slice(0, hash);
    if (!looksLikePath(path)) continue;
    const target = hash === -1 ? null : span.slice(hash + 1);
    if (!existsSync(join(root, path))) {
      problems.push({ source: REGISTER, message: `${path} does not exist` });
      continue;
    }
    if (target === null) continue;
    const source = read(root, path);
    if (source === null) {
      problems.push({ source: REGISTER, message: `${path} is not a file, so it has no ${target}` });
      continue;
    }
    if (target.startsWith('"') && target.endsWith('"') && target.length > 1) {
      const name = target.slice(1, -1);
      if (!hasTestName(source, name)) {
        problems.push({ source: REGISTER, message: `${path} has no test named "${name}"` });
      }
    } else if (/\.ya?ml$/.test(path)) {
      if (!hasYamlJob(source, target)) {
        problems.push({ source: REGISTER, message: `${path} has no job ${target}` });
      }
    } else if (
      !new RegExp(`(^|[^\\w$-])${target.replace(/[$-]/g, "\\$&")}($|[^\\w$-])`).test(source)
    ) {
      problems.push({ source: REGISTER, message: `${path} has no symbol ${target}` });
    }
  }
  return problems;
}

const WEB_BUILDS_A_TRANSACTION =
  /new TransactionBuilder\b|\bbuildFeeBumpTransaction\s*\(|\bOperation\.[a-zA-Z]+\s*\(|\.addOperation\s*\(/;

export function checkWebBuildsNoTransactions(root: string): Problem[] {
  const skip = (path: string): boolean =>
    path.startsWith(join("apps", "web", "tests")) ||
    path.startsWith(join("apps", "web", "scripts"));
  const problems: Problem[] = [];
  for (const file of walk(root, join("apps", "web"), skip)) {
    const lines = readFileSync(join(root, file), "utf8").split("\n");
    lines.forEach((line, i) => {
      if (WEB_BUILDS_A_TRANSACTION.test(line)) {
        problems.push({
          source: `${file}:${i + 1}`,
          message: "the web builds a transaction; only the API may (CLAUDE.md, the trust boundary)",
        });
      }
    });
  }
  return problems;
}

const IMPORT_SPECIFIER = /(?:\bfrom|\bimport|\brequire\s*\()\s*\(?\s*["']([^"']+)["']/g;

export function checkPlaygroundImports(root: string): Problem[] {
  const playground = join("apps", "playground");
  const forbidden = [join(root, "apps", "web"), join(root, "apps", "api")];
  const problems: Problem[] = [];
  for (const file of walk(root, playground, () => false)) {
    const source = readFileSync(join(root, file), "utf8");
    for (const match of source.matchAll(IMPORT_SPECIFIER)) {
      const spec = match[1]!;
      const aliased =
        /^@lumenwipe\/(api|web)(\/|$)/.test(spec) || /(^|\/)apps\/(api|web)\//.test(spec);
      const relativeTarget = spec.startsWith(".") ? resolve(root, dirname(file), spec) : null;
      const escapes =
        relativeTarget !== null &&
        forbidden.some((dir) => relativeTarget === dir || relativeTarget.startsWith(dir + sep));
      if (aliased || escapes) {
        problems.push({
          source: file,
          message: `imports ${spec}; the playground reaches the API only through @lumenwipe/sdk`,
        });
      }
    }
  }
  return problems;
}

export function checkControllerList(root: string): Problem[] {
  const claude = read(root, CLAUDE_MD);
  const match = claude?.match(/Controllers under `src\/\{([^}]+)\}`/);
  if (!match) {
    return [{ source: CLAUDE_MD, message: "the API controller list (`src/{...}`) was not found" }];
  }
  const documented = new Set(match[1]!.split(",").map((name) => name.trim()));
  const src = join(root, "apps", "api", "src");
  const actual = new Set(
    readdirSync(src, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) =>
        readdirSync(join(src, entry.name)).some((name) => name.endsWith(".controller.ts"))
      )
      .map((entry) => entry.name)
  );
  const problems: Problem[] = [];
  for (const name of actual) {
    if (!documented.has(name)) {
      problems.push({
        source: CLAUDE_MD,
        message: `apps/api/src/${name} has a controller but is not listed`,
      });
    }
  }
  for (const name of documented) {
    if (!actual.has(name)) {
      problems.push({
        source: CLAUDE_MD,
        message: `lists ${name}, which has no controller in apps/api/src`,
      });
    }
  }
  return problems;
}

export function checkFormatCommand(root: string): Problem[] {
  const claude = read(root, CLAUDE_MD);
  const match = claude?.match(/CI's `([\w-]+)` job runs `([^`]+)`/);
  if (!match) {
    return [
      {
        source: CLAUDE_MD,
        message: "the sentence naming CI's format job and command was not found",
      },
    ];
  }
  const [, job, command] = match;
  const workflow = read(root, CI_WORKFLOW) ?? "";
  const start = workflow.search(new RegExp(`^  ${job}:\\s*$`, "m"));
  if (start === -1) {
    return [
      { source: CLAUDE_MD, message: `names CI job ${job}, which ${CI_WORKFLOW} does not define` },
    ];
  }
  const rest = workflow.slice(start + 1);
  const next = rest.search(/^  [\w-]+:\s*$/m);
  const block = next === -1 ? rest : rest.slice(0, next);
  if (
    !new RegExp(`^\\s*(?:- )?run: ${command!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m").test(
      block
    )
  ) {
    return [
      { source: CLAUDE_MD, message: `says CI's ${job} job runs ${command}, but it does not` },
    ];
  }
  return [];
}

export function checkThreatModelCoverage(root: string): Problem[] {
  const text = read(root, THREAT_MODEL);
  const coverage = text && section(text, /^## \d+\. Coverage cross-reference\s*$/);
  if (!coverage) {
    return [
      { source: THREAT_MODEL, message: "the coverage cross-reference section was not found" },
    ];
  }
  const problems: Problem[] = [];
  for (const span of codeSpans(coverage)) {
    if (!looksLikePath(span)) continue;
    for (const path of expandBraces(span)) {
      if (!existsSync(join(root, path))) {
        problems.push({
          source: THREAT_MODEL,
          message: `the coverage section cites ${path}, which does not exist`,
        });
      }
    }
  }
  return problems;
}

export function checkAll(root: string): Problem[] {
  return [
    ...checkRegister(root),
    ...checkWebBuildsNoTransactions(root),
    ...checkPlaygroundImports(root),
    ...checkControllerList(root),
    ...checkFormatCommand(root),
    ...checkThreatModelCoverage(root),
  ];
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const problems = checkAll(root);
  for (const problem of problems) {
    console.error(
      `${relative(root, join(root, problem.source)) || problem.source}: ${problem.message}`
    );
  }
  if (problems.length > 0) {
    console.error(`\n${problems.length} documented claim(s) no longer match the code.`);
    process.exit(1);
  }
  console.log("Every documented claim checked matches the code.");
}
