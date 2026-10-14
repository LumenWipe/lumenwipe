import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export interface Problem {
  source: string;
  message: string;
}

const REGISTER = "docs/invariants.mdx";
const THREAT_MODEL = "docs/threat-model.md";
const CLAUDE_MD = "CLAUDE.md";
const CI_WORKFLOW = ".github/workflows/ci.yml";
const SDK_PACKAGE = "packages/sdk/package.json";
const SDK_SOURCE = "packages/sdk/src";
const STELLAR_SDK = "@stellar/stellar-sdk";
const SKIPPED_DIRS = new Set([
  "node_modules",
  ".next",
  ".vercel",
  ".stryker-tmp",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "out",
  "reports",
]);
const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const REPO_PATH = /^(apps|packages|scripts|docs|diagrams|\.github)\/(?:[\w@.,/-]|\{[^{}\n]*\})+$/;

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}

function read(root: string, path: string): string | null {
  try {
    return readFileSync(join(root, path), "utf8");
  } catch {
    return null;
  }
}

function walk(root: string, dir: string, skip: (path: string) => boolean): string[] {
  const full = join(root, dir);
  if (!existsSync(full)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name) && !skip(path)) files.push(...walk(root, path, skip));
    } else if (SOURCE_FILE.test(entry.name) && !skip(path)) {
      files.push(path);
    }
  }
  return files;
}

function within(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

/**
 * Blanks out comments, keeping every newline so offsets and line numbers still hold. String
 * literals are skipped, so a glob inside a string is never read as a comment.
 */
export function stripComments(source: string): string {
  let out = "";
  let quote: string | null = null;
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (quote !== null) {
      const escaped = c === "\\" ? source.slice(i, i + 2) : c;
      out += escaped;
      if (escaped === quote) quote = null;
      i += escaped.length;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i++;
      continue;
    }
    let stop = -1;
    if (source.startsWith("//", i)) {
      stop = source.indexOf("\n", i);
      if (stop === -1) stop = source.length;
    } else if (source.startsWith("/*", i)) {
      const close = source.indexOf("*/", i + 2);
      stop = close === -1 ? source.length : close + 2;
    }
    if (stop === -1) {
      out += c;
      i++;
      continue;
    }
    out += source.slice(i, stop).replace(/[^\n]/g, " ");
    i = stop;
  }
  return out;
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

export function codeSpans(text: string): string[] {
  return [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!);
}

export function expandBraces(path: string): string[] {
  const match = /\{([^{}]+)\}/.exec(path);
  if (!match) return [path];
  const [whole, options] = match;
  const expanded = options!
    .split(",")
    .map((option) => option.trim())
    .flatMap((option) => expandBraces(path.replace(whole, option)));
  return [...new Set(expanded)];
}

function section(text: string, heading: RegExp): string | null {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return null;
  const end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

/** The `jobs:` block of a workflow, so a key under `on:` or `env:` is never taken for a job. */
function jobsBlock(workflow: string): string {
  const start = workflow.search(/^jobs:\s*$/m);
  if (start === -1) return "";
  const bodyStart = workflow.indexOf("\n", start) + 1;
  if (bodyStart === 0) return "";
  const body = workflow.slice(bodyStart);
  const end = body.search(/^\S/m);
  return end === -1 ? body : body.slice(0, end);
}

function jobBody(workflow: string, job: string): string | null {
  const jobs = jobsBlock(workflow);
  const start = jobs.search(new RegExp(`^  ${escapeRegExp(job)}:\\s*$`, "m"));
  if (start === -1) return null;
  const rest = jobs.slice(start + 1);
  const end = rest.search(/^  [\w-]+:\s*$/m);
  return end === -1 ? rest : rest.slice(0, end);
}

/** A declaration of `name`, not a mention: comments are ignored. Config rule keys count. */
export function declares(source: string, name: string): boolean {
  const code = stripComments(source);
  const n = escapeRegExp(name);
  return [
    new RegExp(`\\b(?:function\\*?|class|const|let|var|interface|type|enum)\\s+${n}(?![\\w$])`),
    new RegExp(`\\bexport\\s*\\{[^}]*(?<![\\w$])${n}(?![\\w$])[^}]*\\}`),
    new RegExp(
      `^\\s*(?:(?:public|private|protected|static|async|readonly|get|set)\\s+)+${n}\\s*\\(`,
      "m"
    ),
    new RegExp(`^\\s*${n}\\s*\\([^()]*\\)\\s*(?::\\s*[^={;]+)?\\{`, "m"),
    new RegExp(`["']${n}["']\\s*:`),
  ].some((pattern) => pattern.test(code));
}

/** A test registered under exactly `name`, and not skipped or left as a todo. */
export function hasTest(source: string, name: string): boolean {
  const code = stripComments(source);
  const quoted = [`"${name}"`, `'${name}'`, `\`${name}\``].map(escapeRegExp).join("|");
  return new RegExp(
    `\\b(?:test|it)(?:\\.(?:only|concurrent|serial))?\\s*\\(\\s*(?:${quoted})`
  ).test(code);
}

const REFERENCE = /^((?:[\w@.,/-]|\{[^{}\n]*\})+?)(?:#(.+))?$/;

function checkReference(root: string, span: string): string | null {
  const [, rawPath, target] = REFERENCE.exec(span) ?? [];
  if (!rawPath || !REPO_PATH.test(rawPath)) {
    return `\`${span}\` is not a reference this check can read`;
  }
  for (const path of expandBraces(rawPath)) {
    if (target === undefined) {
      if (!existsSync(join(root, path))) return `${path} does not exist`;
      continue;
    }
    const source = read(root, path);
    if (source === null) {
      return existsSync(join(root, path))
        ? `${path} is not a file, so it has no ${target}`
        : `${path} does not exist`;
    }
    if (target.length > 1 && target.startsWith('"') && target.endsWith('"')) {
      const name = target.slice(1, -1);
      if (!hasTest(source, name)) return `${path} has no active test named "${name}"`;
    } else if (/\.ya?ml$/.test(path)) {
      if (jobBody(source, target) === null) return `${path} has no job ${target}`;
    } else if (!declares(source, target)) {
      return `${path} does not declare ${target}`;
    }
  }
  return null;
}

/**
 * Every code span in a register row's "Enforced by" and "Proved by" cells that names a path must
 * resolve: `path`, `path#symbol` (a declaration, or a job in a workflow) or `path#"test name"`
 * (an active `test()` with exactly that name). A row whose status starts with "Enforced" must
 * name at least one test or job.
 */
export function checkRegister(root: string): Problem[] {
  const text = read(root, REGISTER);
  if (text === null) return [{ source: REGISTER, message: "the invariant register is missing" }];
  const problems: Problem[] = [];
  const rows = text.split("\n").filter((line) => /^\|\s*INV-\d+\s*\|/.test(line));
  if (rows.length === 0) problems.push({ source: REGISTER, message: "the register has no rows" });
  for (const row of rows) {
    const cells = row
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    const id = cells[0]!;
    if (cells.length !== 5) {
      problems.push({ source: REGISTER, message: `${id} has ${cells.length} cells, expected 5` });
      continue;
    }
    const [, , enforcedBy, provedBy, status] = cells as [string, string, string, string, string];
    for (const span of [...codeSpans(enforcedBy), ...codeSpans(provedBy)]) {
      if (!span.includes("/")) continue;
      const problem = checkReference(root, span);
      if (problem) problems.push({ source: REGISTER, message: `${id}: ${problem}` });
    }
    const proofs = codeSpans(provedBy).filter((span) => span.includes("#"));
    if (status.startsWith("Enforced") && proofs.length === 0) {
      problems.push({
        source: REGISTER,
        message: `${id} is marked Enforced but names no test or job`,
      });
    }
  }
  return problems;
}

const WEB_BUILDS_A_TRANSACTION = [
  /\bnew\s+(?:[\w$]+\s*\.\s*)?TransactionBuilder\b/g,
  /\bTransactionBuilder\s*\.\s*(?:cloneFrom|buildFeeBumpTransaction)\b/g,
  /\bTransactionBuilder\s+as\s+[\w$]+/g,
  /\bOperation\s*\.\s*(?!fromXDRObject\b|isValidAmount\b|setSourceAccount\b)[a-z]\w*\s*\(/g,
  /\.addOperation\s*\(/g,
];

/**
 * A heuristic over the web's source, not a type-level proof: it catches the usual ways to build
 * with the Stellar SDK. Parsing (`TransactionBuilder.fromXDR`, `Operation.fromXDRObject`) is
 * allowed, and so is anything under the web's `tests/` and `scripts/`.
 */
export function checkWebBuildsNoTransactions(root: string): Problem[] {
  const skip = (path: string): boolean =>
    within(path, "apps/web/tests") || within(path, "apps/web/scripts");
  const problems: Problem[] = [];
  for (const file of walk(root, "apps/web", skip)) {
    const code = stripComments(readFileSync(join(root, file), "utf8"));
    const hits = new Set<number>();
    for (const pattern of WEB_BUILDS_A_TRANSACTION) {
      for (const match of code.matchAll(pattern)) hits.add(lineOf(code, match.index));
    }
    for (const line of [...hits].sort((a, b) => a - b)) {
      problems.push({
        source: `${file}:${line}`,
        message: "the web builds a transaction; only the API may (CLAUDE.md, the trust boundary)",
      });
    }
  }
  return problems;
}

const IMPORT_SPECIFIER =
  /(?:\bfrom|\bimport|\brequire\s*\(|\bimport\s*\()\s*\(?\s*["'`]([^"'`]+)["'`]/g;

export function checkPlaygroundImports(root: string): Problem[] {
  const forbidden = [resolve(root, "apps/web"), resolve(root, "apps/api")];
  const problems: Problem[] = [];
  for (const file of walk(root, "apps/playground", () => false)) {
    const code = stripComments(readFileSync(join(root, file), "utf8"));
    for (const match of code.matchAll(IMPORT_SPECIFIER)) {
      const spec = match[1]!;
      const aliased =
        /^@lumenwipe\/(api|web)(\/|$)/.test(spec) || /(^|\/)apps\/(api|web)(\/|$)/.test(spec);
      const target = spec.startsWith(".") ? resolve(root, dirname(file), spec) : null;
      const escapes =
        target !== null && forbidden.some((dir) => target === dir || target.startsWith(dir + sep));
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
  const claude = read(root, CLAUDE_MD) ?? "";
  const match = claude.match(/Controllers under `src\/\{([^}]+)\}`(?:, plus ([^\n]*))?/);
  if (!match) {
    return [{ source: CLAUDE_MD, message: "the API controller list (`src/{...}`) was not found" }];
  }
  if (!existsSync(join(root, "apps", "api", "src"))) {
    return [{ source: CLAUDE_MD, message: "apps/api/src does not exist" }];
  }
  const documented = new Set(match[1]!.split(",").map((name) => name.trim()));
  const documentedRoot = new Set(
    [...(match[2] ?? "").matchAll(/`src\/([\w.-]+\.controller\.ts)`/g)].map((m) => m[1]!)
  );
  const controllers = walk(root, "apps/api/src", () => false)
    .filter((file) => file.endsWith(".controller.ts"))
    .map((file) => file.slice("apps/api/src/".length));
  const nested = new Set(controllers.filter((f) => f.includes("/")).map((f) => f.split("/")[0]!));
  const atRoot = new Set(controllers.filter((f) => !f.includes("/")));
  const problems: Problem[] = [];
  const report = (message: string): void => {
    problems.push({ source: CLAUDE_MD, message });
  };
  for (const name of nested) {
    if (!documented.has(name)) report(`apps/api/src/${name} has a controller but is not listed`);
  }
  for (const name of documented) {
    if (!nested.has(name)) report(`lists ${name}, which has no controller in apps/api/src`);
  }
  for (const name of atRoot) {
    if (!documentedRoot.has(name)) report(`apps/api/src/${name} is not listed`);
  }
  for (const name of documentedRoot) {
    if (!atRoot.has(name)) report(`lists src/${name}, which does not exist`);
  }
  return problems;
}

export function checkFormatCommand(root: string): Problem[] {
  const claude = read(root, CLAUDE_MD) ?? "";
  const match = claude.match(/CI's `([\w-]+)` job runs `([^`]+)`/);
  if (!match) {
    return [
      {
        source: CLAUDE_MD,
        message: "the sentence naming CI's format job and command was not found",
      },
    ];
  }
  const job = match[1]!;
  const command = match[2]!;
  const body = jobBody(read(root, CI_WORKFLOW) ?? "", job);
  if (body === null) {
    return [
      { source: CLAUDE_MD, message: `names CI job ${job}, which ${CI_WORKFLOW} does not define` },
    ];
  }
  const runs = new RegExp(
    `^(?:-\\s+)?(?:run:\\s*)?["']?${escapeRegExp(command)}(?=["']?\\s*(?:$|&&|;|\\|))`
  );
  if (body.split("\n").some((line) => runs.test(line.trim()))) return [];
  return [{ source: CLAUDE_MD, message: `says CI's ${job} job runs ${command}, but it does not` }];
}

export function checkSdkDoesNotBundleStellarSdk(root: string): Problem[] {
  const manifest = read(root, SDK_PACKAGE);
  if (manifest === null) return [{ source: SDK_PACKAGE, message: "is missing" }];
  const parsed = JSON.parse(manifest) as Record<string, Record<string, string> | undefined>;
  const problems: Problem[] = [];
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    if (parsed[field]?.[STELLAR_SDK] !== undefined) {
      problems.push({ source: SDK_PACKAGE, message: `lists ${STELLAR_SDK} in ${field}` });
    }
  }
  for (const file of walk(root, SDK_SOURCE, () => false)) {
    const code = stripComments(readFileSync(join(root, file), "utf8"));
    for (const match of code.matchAll(IMPORT_SPECIFIER)) {
      const spec = match[1]!;
      if (spec === STELLAR_SDK || spec.startsWith(`${STELLAR_SDK}/`)) {
        problems.push({
          source: file,
          message: `imports ${spec}, which the published SDK must not bundle`,
        });
      }
    }
  }
  return problems;
}

export function checkThreatModelCoverage(root: string): Problem[] {
  const text = read(root, THREAT_MODEL);
  const coverage = text && section(text, /^## \d+\. Coverage cross-reference\s*$/);
  if (!coverage) {
    return [
      { source: THREAT_MODEL, message: "the coverage cross-reference section was not found" },
    ];
  }
  const paths = codeSpans(coverage).filter((span) => REPO_PATH.test(span));
  if (paths.length === 0) {
    return [{ source: THREAT_MODEL, message: "the coverage section cites no repository path" }];
  }
  const problems: Problem[] = [];
  for (const span of paths) {
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
    ...checkSdkDoesNotBundleStellarSdk(root),
    ...checkThreatModelCoverage(root),
  ].map((problem) => ({ ...problem, source: toPosix(problem.source) }));
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? join(import.meta.dir, ".."));
  const problems = checkAll(root);
  for (const problem of problems) console.error(`${problem.source}: ${problem.message}`);
  if (problems.length > 0) {
    console.error(`\n${problems.length} documented claim(s) no longer match the code.`);
    process.exit(1);
  }
  console.log("Every documented claim checked matches the code.");
}
