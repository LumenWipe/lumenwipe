// Release checks for the published packages, @lumenwipe/sdk and @lumenwipe/verify: their version,
// changelog, docs pin, git tags and npm must agree, and a change to what a package ships needs a
// changelog entry.
//
//   bun scripts/package-release.ts <sdk|verify> offline       files only (release:check)
//   bun scripts/package-release.ts <sdk|verify> pr            files, npm and tags; BASE_REF names the PR's base branch
//   bun scripts/package-release.ts <sdk|verify> publish       files, npm and tags for the tag in TAG (publish-*.yml)
//   bun scripts/package-release.ts <sdk|verify> changelog     a shipped change since BASE_REF needs an [Unreleased] entry
//   bun scripts/package-release.ts <sdk|verify> notes X.Y.Z   prints that version's changelog section
//
// A version that is in the changelog but not on npm yet (a merged release PR waiting for its tag),
// or a package whose first release is not cut yet, is a warning in every mode but publish, never a
// failure, so no PR waits on a publish. Only real inconsistencies fail. Network use is read-only:
// `npm view` and `git ls-remote`.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export const REPO_URL = "https://github.com/LumenWipe/lumenwipe";
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const VERSION_HEADING = /^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})$/;
const UNRELEASED_HEADING = "## [Unreleased]";
const NOT_PUBLISHED = /^Not published to npm; first available in (\d+\.\d+\.\d+)\.$/;
const LINK_DEFINITION = /^\[([^\]\n]+)\]: (\S+)$/;
const BRANCH_NAME = /^[A-Za-z0-9._/]+$/;

export type PackageId = "sdk" | "verify";

export interface PackageConfig {
  id: PackageId;
  name: string;
  /** Repository-relative directory. */
  dir: string;
  /** A release of X.Y.Z is tagged `${tagPrefix}X.Y.Z`. */
  tagPrefix: string;
  /** A source constant that must equal package.json's version. */
  versionConstant: { file: string; label: string; pattern: RegExp } | null;
  /** The `"<name>": "<range>"` pin the docs must carry, global. */
  docsPin: RegExp | null;
}

export const PACKAGES: Record<PackageId, PackageConfig> = {
  sdk: {
    id: "sdk",
    name: "@lumenwipe/sdk",
    dir: "packages/sdk",
    tagPrefix: "sdk-v",
    versionConstant: {
      file: "src/version.ts",
      label: "SDK_VERSION",
      pattern: /export const SDK_VERSION = "([^"\n]*)";/,
    },
    docsPin: /"@lumenwipe\/sdk":\s*"([^"\n]*)"/g,
  },
  verify: {
    id: "verify",
    name: "@lumenwipe/verify",
    dir: "packages/verify",
    tagPrefix: "verify-v",
    versionConstant: null,
    docsPin: null,
  },
};

export function isPackageId(value: string | undefined): value is PackageId {
  return value === "sdk" || value === "verify";
}

export type Mode = "offline" | "pr" | "publish";

export interface DocsFile {
  path: string;
  text: string;
}

export interface RegistryState {
  versions: string[];
  /** null when the package was never published. */
  latest: string | null;
}

export interface AgreementInput {
  pkg: PackageConfig;
  mode: Mode;
  packageVersion: string;
  /** The package's version constant, when it has one. */
  versionConstant?: string;
  changelog: string;
  docs: DocsFile[];
  /** pr and publish only. */
  npm?: RegistryState;
  /** pr and publish only: the package's tags on the remote. */
  tags?: string[];
  /** pr only: package.json's version on the base branch, when there is one. */
  baseVersion?: string;
  /** publish only. */
  tag?: string;
  /** publish only: the tag's commit is an ancestor of origin/main. */
  tagOnMain?: boolean;
  /** publish only: the checked-out commit is the tag's commit. */
  headIsTag?: boolean;
}

export interface Verdict {
  errors: string[];
  warnings: string[];
}

export interface ChangelogEntry {
  version: string;
  date: string;
  /** The version this one first shipped in, when it was never published itself. */
  firstAvailableIn: string | null;
  body: string;
}

export interface ParsedChangelog {
  entries: ChangelogEntry[];
  /** The body of `## [Unreleased]`, trimmed; empty when there is none. */
  unreleased: string;
  links: Map<string, string>;
  problems: string[];
}

export function parseSemver(version: string): [number, number, number] | null {
  const match = SEMVER.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Negative when a < b, positive when a > b. Both must be X.Y.Z. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) throw new Error(`not a version: ${pa ? b : a}`);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/** The X.Y.Z a tag names when it is exactly `${prefix}X.Y.Z`, otherwise null. */
export function tagVersion(pkg: PackageConfig, tag: string): string | null {
  if (!tag.startsWith(pkg.tagPrefix)) return null;
  const version = tag.slice(pkg.tagPrefix.length);
  return parseSemver(version) ? version : null;
}

export function parseChangelog(text: string): ParsedChangelog {
  const entries: ChangelogEntry[] = [];
  const links = new Map<string, string>();
  const problems: string[] = [];
  const unreleasedLines: string[] = [];
  let sawUnreleased = false;
  let inUnreleased = false;
  let current: { entry: ChangelogEntry; lines: string[] } | null = null;
  const close = (): void => {
    if (!current) return;
    current.entry.body = current.lines.join("\n").trim();
    entries.push(current.entry);
    current = null;
  };

  for (const line of text.split("\n")) {
    const link = LINK_DEFINITION.exec(line);
    if (link) {
      if (links.has(link[1])) problems.push(`link [${link[1]}] is defined twice`);
      links.set(link[1], link[2]);
      continue;
    }
    if (!line.startsWith("## ")) {
      if (inUnreleased) unreleasedLines.push(line);
      if (current) {
        current.lines.push(line);
        const marker = NOT_PUBLISHED.exec(line);
        if (marker) current.entry.firstAvailableIn = marker[1];
      }
      continue;
    }
    close();
    inUnreleased = false;
    if (line === UNRELEASED_HEADING) {
      if (sawUnreleased) problems.push("## [Unreleased] appears twice");
      if (entries.length > 0) problems.push("## [Unreleased] must come before every version");
      sawUnreleased = true;
      inUnreleased = true;
      continue;
    }
    const heading = VERSION_HEADING.exec(line);
    if (!heading || !parseSemver(heading[1])) {
      problems.push(`malformed heading "${line}" (expected "## [X.Y.Z] - YYYY-MM-DD")`);
      continue;
    }
    current = {
      entry: { version: heading[1], date: heading[2], firstAvailableIn: null, body: "" },
      lines: [],
    };
  }
  close();
  if (!sawUnreleased) problems.push("no ## [Unreleased] heading");
  return { entries, unreleased: unreleasedLines.join("\n").trim(), links, problems };
}

/** The exact link definitions the changelog must carry: published versions only. */
export function expectedLinks(pkg: PackageConfig, entries: ChangelogEntry[]): Map<string, string> {
  const shipped = entries.filter((e) => e.firstAvailableIn === null).map((e) => e.version);
  const links = new Map<string, string>();
  if (shipped.length === 0) return links;
  const tag = (version: string): string => `${pkg.tagPrefix}${version}`;
  links.set("Unreleased", `${REPO_URL}/compare/${tag(shipped[0])}...HEAD`);
  shipped.forEach((version, i) => {
    const previous = shipped[i + 1];
    links.set(
      version,
      previous
        ? `${REPO_URL}/compare/${tag(previous)}...${tag(version)}`
        : `${REPO_URL}/tree/${tag(version)}`
    );
  });
  return links;
}

export function docsPins(pattern: RegExp, docs: DocsFile[]): { path: string; range: string }[] {
  const pins: { path: string; range: string }[] = [];
  for (const file of docs) {
    for (const match of file.text.matchAll(pattern))
      pins.push({ path: file.path, range: match[1] });
  }
  return pins;
}

function checkFiles(input: AgreementInput, verdict: Verdict, parsed: ParsedChangelog): void {
  const { errors, warnings } = verdict;
  const { pkg } = input;
  const version = input.packageVersion;
  if (!parseSemver(version)) {
    errors.push(`package.json version "${version}" is not X.Y.Z`);
    return;
  }
  if (pkg.versionConstant && input.versionConstant !== version) {
    errors.push(
      `${pkg.versionConstant.label} is "${input.versionConstant ?? "(missing)"}" but package.json is "${version}"`
    );
  }

  errors.push(...parsed.problems.map((p) => `CHANGELOG.md: ${p}`));
  const { entries } = parsed;
  const seen = new Set<string>();
  entries.forEach((entry, i) => {
    if (seen.has(entry.version)) errors.push(`CHANGELOG.md: ${entry.version} has two headings`);
    seen.add(entry.version);
    const next = entries[i + 1];
    if (next && compareSemver(entry.version, next.version) <= 0) {
      errors.push(`CHANGELOG.md: ${entry.version} is listed above ${next.version}; newest first`);
    }
    if (next && entry.date < next.date) {
      errors.push(`CHANGELOG.md: ${entry.version} is dated before ${next.version}`);
    }
  });

  const top = entries[0];
  if (!top) {
    // A package whose first release is not cut yet: everything is still under [Unreleased].
    if (input.mode === "publish") errors.push(`CHANGELOG.md has no heading for ${version}`);
    else {
      warnings.push(
        `package.json is ${version} and CHANGELOG.md has no released heading yet: the first release is still to be cut.`
      );
    }
  } else if (top.version !== version) {
    errors.push(`CHANGELOG.md's newest heading is ${top.version} but package.json is ${version}`);
  } else if (top.firstAvailableIn !== null) {
    errors.push(`CHANGELOG.md marks ${version}, the current version, as not published`);
  }

  // A version that never shipped names the next one that did, which is the release it is in.
  entries.forEach((entry, i) => {
    if (entry.firstAvailableIn === null) return;
    const shippedIn = entries
      .slice(0, i)
      .reverse()
      .find((e) => e.firstAvailableIn === null);
    if (!shippedIn || shippedIn.version !== entry.firstAvailableIn) {
      errors.push(
        `CHANGELOG.md: ${entry.version} says it first shipped in ${entry.firstAvailableIn}, but the next published heading is ${shippedIn?.version ?? "none"}`
      );
    }
  });

  const expected = expectedLinks(pkg, entries);
  for (const [label, url] of expected) {
    const actual = parsed.links.get(label);
    if (actual !== url) {
      errors.push(`CHANGELOG.md: link [${label}] must be ${url}${actual ? `, not ${actual}` : ""}`);
    }
  }
  for (const label of parsed.links.keys()) {
    if (!expected.has(label)) {
      errors.push(
        `CHANGELOG.md: link [${label}] has no published heading (unpublished versions get no link)`
      );
    }
  }

  if (pkg.docsPin) {
    const [major, minor] = parseSemver(version)!;
    const wanted = `~${major}.${minor}.0`;
    const pins = docsPins(pkg.docsPin, input.docs);
    if (pins.length === 0) errors.push(`no docs page pins "${pkg.name}"`);
    for (const pin of pins) {
      if (pin.range !== wanted) {
        errors.push(`${pin.path} pins "${pkg.name}": "${pin.range}", expected "${wanted}"`);
      }
    }
  }
}

function checkRegistry(input: AgreementInput, verdict: Verdict, entries: ChangelogEntry[]): void {
  const { errors, warnings } = verdict;
  const { pkg, npm, tags } = input;
  if (!npm || !tags) {
    errors.push(`${input.mode} mode needs the npm state and the remote tags`);
    return;
  }
  const version = input.packageVersion;
  const published = npm.versions.filter((v) => parseSemver(v));
  const onNpm = new Set(published);
  const byVersion = new Map(entries.map((e) => [e.version, e]));
  const tagged = new Set<string>();
  for (const tag of tags) {
    const v = tagVersion(pkg, tag);
    if (v) tagged.add(v);
  }
  const latest = npm.latest;

  if (latest === null) {
    // Never published. Only the current version's tag may exist yet (its first publish is
    // running or failed); a tag for any other version means npm lost a release, or the answer
    // that the package does not exist is wrong.
    if (published.length > 0) errors.push(`npm has versions of ${pkg.name} but no latest dist-tag`);
    for (const v of [...tagged].sort(compareSemver)) {
      if (v !== version) {
        errors.push(`tag ${pkg.tagPrefix}${v} exists, but npm has no version of ${pkg.name}`);
      }
    }
  } else {
    if (!parseSemver(latest)) {
      errors.push(`npm latest "${latest}" is not X.Y.Z`);
      return;
    }
    const highest = [...published].sort(compareSemver).pop();
    if (highest && highest !== latest) {
      errors.push(`npm latest is ${latest} but ${highest} is published`);
    }
  }

  for (const v of published) {
    const entry = byVersion.get(v);
    if (!entry) errors.push(`${v} is on npm but has no CHANGELOG.md heading`);
    else if (entry.firstAvailableIn !== null) {
      errors.push(`CHANGELOG.md marks ${v} as not published, but npm has it`);
    }
    if (!tagged.has(v)) errors.push(`${v} is on npm but tag ${pkg.tagPrefix}${v} does not exist`);
  }
  for (const v of tagged) {
    if (!byVersion.has(v)) errors.push(`tag ${pkg.tagPrefix}${v} has no CHANGELOG.md heading`);
    else if (byVersion.get(v)!.firstAvailableIn !== null) {
      errors.push(`tag ${pkg.tagPrefix}${v} exists, but CHANGELOG.md marks ${v} as not published`);
    }
  }
  if (latest !== null && compareSemver(latest, version) > 0) {
    errors.push(`npm latest ${latest} is ahead of package.json ${version}`);
  }

  const releasePr =
    input.mode === "pr" && input.baseVersion !== undefined && input.baseVersion !== version;

  // Merged but not published yet: a release waiting for its tag. Never a failure. The version a
  // release PR introduces, or the one being published, is checked on its own below instead.
  for (const entry of entries) {
    if (entry.firstAvailableIn !== null || onNpm.has(entry.version)) continue;
    if (entry.version === version && (releasePr || input.mode === "publish")) continue;
    const tagNote = tagged.has(entry.version)
      ? ` Tag ${pkg.tagPrefix}${entry.version} exists, so its publish is running or failed.`
      : "";
    warnings.push(
      `${entry.version} is in CHANGELOG.md but not on npm yet: a merged release waiting to be published.${tagNote}`
    );
  }

  const notAboveLatest = latest !== null && compareSemver(version, latest) <= 0;

  if (releasePr && input.baseVersion !== undefined) {
    if (!parseSemver(input.baseVersion)) {
      errors.push(`the base branch's version "${input.baseVersion}" is not X.Y.Z`);
    } else if (compareSemver(version, input.baseVersion) <= 0) {
      errors.push(`release ${version} is not greater than the base branch's ${input.baseVersion}`);
    }
    if (onNpm.has(version)) errors.push(`release ${version} is already on npm`);
    else if (notAboveLatest) {
      errors.push(`release ${version} is not greater than npm latest ${latest}`);
    }
    if (tagged.has(version)) {
      errors.push(`release ${version} already has tag ${pkg.tagPrefix}${version}`);
    }
  }

  if (input.mode === "publish") {
    const tag = input.tag ?? "";
    const named = tagVersion(pkg, tag);
    if (named === null) errors.push(`tag "${tag}" is not ${pkg.tagPrefix}X.Y.Z`);
    else if (named !== version) {
      errors.push(`tag ${tag} does not match package.json version ${version}`);
    }
    if (input.tagOnMain !== true) errors.push(`tag ${tag} is not on main`);
    if (input.headIsTag !== true) errors.push(`the checked-out commit is not tag ${tag}`);
    if (onNpm.has(version)) errors.push(`${version} is already on npm`);
    else if (notAboveLatest) {
      errors.push(`${version} is not greater than npm latest ${latest}`);
    }
  }
}

export function checkAgreement(input: AgreementInput): Verdict {
  const verdict: Verdict = { errors: [], warnings: [] };
  const parsed = parseChangelog(input.changelog);
  checkFiles(input, verdict, parsed);
  if (input.mode !== "offline" && parseSemver(input.packageVersion)) {
    checkRegistry(input, verdict, parsed.entries);
  }
  return verdict;
}

export function releaseNotes(changelog: string, version: string): string | null {
  const entry = parseChangelog(changelog).entries.find((e) => e.version === version);
  return entry ? entry.body : null;
}

/** True when `npm view --json` output is npm's "package not found" error. */
export function isNpmNotFound(json: string): boolean {
  try {
    const data = JSON.parse(json) as { error?: { code?: unknown } } | null;
    return data?.error?.code === "E404";
  } catch {
    return false;
  }
}

/** Normalizes `npm view <pkg> versions dist-tags --json`. */
export function parseNpmView(json: string): RegistryState {
  const data = JSON.parse(json) as { versions?: unknown; "dist-tags"?: { latest?: unknown } };
  const versions =
    typeof data.versions === "string"
      ? [data.versions]
      : Array.isArray(data.versions)
        ? data.versions.filter((v): v is string => typeof v === "string")
        : [];
  const latest = data["dist-tags"]?.latest;
  if (versions.length === 0 || typeof latest !== "string") {
    throw new Error("npm view returned no versions or no latest dist-tag");
  }
  return { versions, latest };
}

/** Tag names from `git ls-remote --tags --refs`. */
export function parseLsRemote(output: string): string[] {
  const tags: string[] = [];
  for (const line of output.split("\n")) {
    const ref = line.split("\t")[1];
    if (ref?.startsWith("refs/tags/")) tags.push(ref.slice("refs/tags/".length));
  }
  return tags;
}

// The changelog guard.

/** package.json fields a consumer of the published package sees. */
export const CONSUMER_FIELDS = [
  "dependencies",
  "engines",
  "exports",
  "files",
  "main",
  "module",
  "peerDependencies",
  "sideEffects",
  "types",
] as const;

export interface ChangeSet {
  /** Repository-relative paths changed since the merge base. */
  changed: string[];
  /** Whether a repository-relative path exists on the base. */
  onBase: (path: string) => boolean;
  /** verify only: the repository-relative files tsup compiles into the bundle, at HEAD. */
  bundleInputs?: string[];
  /** verify only: package.json on the base (null when absent) and at HEAD. */
  manifestBefore?: string | null;
  manifestAfter?: string;
}

function changedConsumerFields(before: string | null, after: string): string[] {
  if (before === null) return [];
  const a = JSON.parse(before) as Record<string, unknown>;
  const b = JSON.parse(after) as Record<string, unknown>;
  return CONSUMER_FIELDS.filter((f) => JSON.stringify(a[f]) !== JSON.stringify(b[f]));
}

/** What changed that reaches the package's consumers: each reason is a path or a field. */
export function shippedChanges(pkg: PackageConfig, set: ChangeSet): string[] {
  const reasons: string[] = [];
  const changed = new Set(set.changed);
  const apiReport = `${pkg.dir}/etc/${pkg.id}.api.md`;
  const under = (prefix: string): boolean => set.changed.some((p) => p.startsWith(prefix));

  if (under(`${pkg.dir}/src/`)) reasons.push(`${pkg.dir}/src/`);
  if (pkg.id === "verify") {
    if (under(`${pkg.dir}/vectors/`)) reasons.push(`${pkg.dir}/vectors/`);
    const tsup = `${pkg.dir}/tsup.config.ts`;
    if (changed.has(tsup)) reasons.push(tsup);
    for (const input of set.bundleInputs ?? []) {
      if (!input.startsWith(`${pkg.dir}/src/`) && changed.has(input)) reasons.push(input);
    }
    const manifest = `${pkg.dir}/package.json`;
    if (changed.has(manifest) && set.manifestAfter !== undefined) {
      for (const field of changedConsumerFields(set.manifestBefore ?? null, set.manifestAfter)) {
        reasons.push(`${manifest} ${field}`);
      }
    }
  }
  // Only a content change to a report that already existed: adding it is not a surface change.
  if (changed.has(apiReport) && set.onBase(apiReport)) reasons.push(apiReport);
  return reasons;
}

/** Fails when something shipped changed but the [Unreleased] section did not. */
export function changelogVerdict(
  pkg: PackageConfig,
  reasons: string[],
  before: string | null,
  after: string
): Verdict {
  const verdict: Verdict = { errors: [], warnings: [] };
  if (reasons.length === 0) return verdict;
  const unreleased = (text: string | null): string =>
    text === null ? "" : parseChangelog(text).unreleased;
  if (unreleased(before) === unreleased(after)) {
    verdict.errors.push(
      `${reasons.join(", ")} changed, but ${pkg.dir}/CHANGELOG.md has no new entry under [Unreleased]. Add one - see RELEASING.md.`
    );
  }
  return verdict;
}

/** The repository-relative files the verify bundle is compiled from, as tsup resolves them. */
export async function bundleInputs(root: string): Promise<string[]> {
  const result = await Bun.build({
    entrypoints: [join(root, PACKAGES.verify.dir, "src/index.ts")],
    target: "browser",
    format: "esm",
    external: ["@stellar/stellar-sdk"],
    metafile: true,
  });
  if (!result.success || !result.metafile) {
    throw new Error(`could not resolve the verify bundle: ${result.logs.join("\n")}`);
  }
  return Object.keys(result.metafile.inputs)
    .map((input) => relative(root, resolve(process.cwd(), input)))
    .sort();
}

// The command line.

const ROOT = resolve(import.meta.dir, "..");

function run(command: string, args: string[]): string {
  return execFileSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function succeeds(command: string, args: string[]): boolean {
  try {
    run(command, args);
    return true;
  } catch {
    return false;
  }
}

async function withRetries<T>(what: string, attempt: () => T): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return attempt();
    } catch (error) {
      if (i === 4) {
        throw new Error(`${what} failed after ${i} attempts: ${String(error)}`, { cause: error });
      }
      await new Promise((done) => setTimeout(done, 2000 * i));
    }
  }
}

function docsFiles(pkg: PackageConfig): DocsFile[] {
  if (!pkg.docsPin) return [];
  const paths = ["README.md", `${pkg.dir}/README.md`];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(path);
      } else if (/\.mdx?$/.test(entry.name)) {
        paths.push(path);
      }
    }
  };
  walk("docs");
  return paths.map((path) => ({ path, text: readFileSync(join(ROOT, path), "utf8") }));
}

function readFiles(
  pkg: PackageConfig
): Pick<AgreementInput, "packageVersion" | "versionConstant" | "changelog" | "docs"> {
  const dir = join(ROOT, pkg.dir);
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    version: string;
  };
  const constant = pkg.versionConstant;
  return {
    packageVersion: manifest.version,
    versionConstant: constant
      ? (constant.pattern.exec(readFileSync(join(dir, constant.file), "utf8"))?.[1] ?? "(missing)")
      : undefined,
    changelog: readFileSync(join(dir, "CHANGELOG.md"), "utf8"),
    docs: docsFiles(pkg),
  };
}

const UNPUBLISHED: RegistryState = { versions: [], latest: null };

function npmState(pkg: PackageConfig): Promise<RegistryState> {
  return withRetries("npm view", () => {
    try {
      return parseNpmView(run("npm", ["view", pkg.name, "versions", "dist-tags", "--json"]));
    } catch (error) {
      // npm exits 1 with its error as JSON on stdout. Only "not found" means never published;
      // anything else is retried and then fails.
      const stdout = (error as { stdout?: unknown }).stdout;
      if (typeof stdout === "string" && isNpmNotFound(stdout)) return UNPUBLISHED;
      throw error;
    }
  });
}

async function remoteState(pkg: PackageConfig): Promise<Pick<AgreementInput, "npm" | "tags">> {
  const npm = await npmState(pkg);
  const tags = await withRetries("git ls-remote", () =>
    parseLsRemote(
      run("git", ["ls-remote", "--tags", "--refs", "origin", `refs/tags/${pkg.tagPrefix}*`])
    )
  );
  return { npm, tags };
}

function baseRef(): string {
  const ref = process.env.BASE_REF ?? "";
  if (ref === "") return "";
  if (!BRANCH_NAME.test(ref) || ref.startsWith(".") || ref.includes("..")) {
    throw new Error(`BASE_REF "${ref}" is not a branch name`);
  }
  return ref;
}

function baseVersion(pkg: PackageConfig): string | undefined {
  const ref = baseRef();
  if (ref === "") return undefined;
  run("git", ["fetch", "--no-tags", "--depth=1", "origin", `refs/heads/${ref}`]);
  const manifest = run("git", ["show", `FETCH_HEAD:${pkg.dir}/package.json`]);
  return (JSON.parse(manifest) as { version: string }).version;
}

function showOnBase(base: string, path: string): string | null {
  try {
    return run("git", ["show", `${base}:${path}`]);
  } catch {
    return null;
  }
}

async function changelogCheck(pkg: PackageConfig): Promise<Verdict> {
  const ref = baseRef();
  if (ref === "") throw new Error("changelog mode needs BASE_REF, the PR's base branch");
  const base = `origin/${ref}`;
  const changed = run("git", ["diff", "--name-only", `${base}...HEAD`])
    .split("\n")
    .filter((p) => p !== "");
  const set: ChangeSet = {
    changed,
    onBase: (path) => succeeds("git", ["cat-file", "-e", `${base}:${path}`]),
  };
  if (pkg.id === "verify") {
    set.bundleInputs = await bundleInputs(ROOT);
    set.manifestBefore = showOnBase(base, `${pkg.dir}/package.json`);
    set.manifestAfter = readFileSync(join(ROOT, pkg.dir, "package.json"), "utf8");
  }
  const reasons = shippedChanges(pkg, set);
  if (reasons.length === 0) {
    console.log(`Nothing ${pkg.name} ships changed - nothing to check.`);
    return { errors: [], warnings: [] };
  }
  const verdict = changelogVerdict(
    pkg,
    reasons,
    showOnBase(base, `${pkg.dir}/CHANGELOG.md`),
    readFileSync(join(ROOT, pkg.dir, "CHANGELOG.md"), "utf8")
  );
  if (verdict.errors.length === 0)
    console.log(`[Unreleased] entry added for: ${reasons.join(", ")}`);
  return verdict;
}

function report(verdict: Verdict, success: string): void {
  const ci = process.env.GITHUB_ACTIONS === "true";
  for (const warning of verdict.warnings)
    console.log(ci ? `::warning::${warning}` : `warning: ${warning}`);
  for (const error of verdict.errors) console.log(ci ? `::error::${error}` : `error: ${error}`);
  if (verdict.errors.length === 0 && success !== "") console.log(success);
}

const USAGE =
  "usage: package-release.ts sdk|verify offline | pr | publish | changelog | notes X.Y.Z";

async function main(argv: string[]): Promise<number> {
  const [id, mode, arg] = argv;
  if (!isPackageId(id)) {
    console.error(USAGE);
    return 2;
  }
  const pkg = PACKAGES[id];
  if (mode === "notes") {
    if (!arg || !parseSemver(arg)) {
      console.error(`usage: package-release.ts ${id} notes X.Y.Z`);
      return 2;
    }
    const notes = releaseNotes(readFileSync(join(ROOT, pkg.dir, "CHANGELOG.md"), "utf8"), arg);
    if (notes === null) {
      console.error(`CHANGELOG.md has no ${arg} heading`);
      return 1;
    }
    console.log(notes);
    return 0;
  }
  if (mode === "changelog") {
    const verdict = await changelogCheck(pkg);
    report(verdict, "");
    return verdict.errors.length === 0 ? 0 : 1;
  }
  if (mode !== "offline" && mode !== "pr" && mode !== "publish") {
    console.error(USAGE);
    return 2;
  }

  const input: AgreementInput = { pkg, mode, ...readFiles(pkg) };
  if (mode === "pr") {
    Object.assign(input, await remoteState(pkg), { baseVersion: baseVersion(pkg) });
  }
  if (mode === "publish") {
    const tag = process.env.TAG ?? "";
    input.tag = tag;
    if (tagVersion(pkg, tag) !== null) {
      const commit = `refs/tags/${tag}^{commit}`;
      run("git", ["fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
      input.tagOnMain = succeeds("git", [
        "merge-base",
        "--is-ancestor",
        commit,
        "refs/remotes/origin/main",
      ]);
      input.headIsTag =
        run("git", ["rev-parse", commit]).trim() === run("git", ["rev-parse", "HEAD"]).trim();
    }
    Object.assign(input, await remoteState(pkg));
  }

  const verdict = checkAgreement(input);
  const checked = [
    "version",
    pkg.versionConstant?.label,
    "changelog",
    pkg.docsPin ? "docs pin" : undefined,
    mode === "offline" ? undefined : "tags",
    mode === "offline" ? undefined : "npm",
  ].filter((part) => part !== undefined);
  const last = checked.pop();
  report(verdict, `${pkg.name}: ${checked.join(", ")} and ${last} agree.`);
  return verdict.errors.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
