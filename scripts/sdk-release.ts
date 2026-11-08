// Checks that the SDK's version, SDK_VERSION, changelog, docs pin, git tags and npm agree.
//
//   bun scripts/sdk-release.ts offline       files only (the sdk row of CI)
//   bun scripts/sdk-release.ts pr            files, npm and tags; BASE_REF names the PR's base branch
//   bun scripts/sdk-release.ts publish       files, npm and tags for the tag in TAG (publish-sdk.yml)
//   bun scripts/sdk-release.ts notes X.Y.Z   prints that version's changelog section
//
// A version that is in the changelog but not on npm yet (a merged release PR waiting for its tag)
// is a warning in every mode, never a failure, so no PR waits on a publish. Only real
// inconsistencies fail. Network use is read-only: `npm view` and `git ls-remote`.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const PACKAGE_NAME = "@lumenwipe/sdk";
export const REPO_URL = "https://github.com/LumenWipe/lumenwipe";
export const TAG_PATTERN = /^sdk-v(\d+\.\d+\.\d+)$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const VERSION_HEADING = /^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})$/;
const UNRELEASED_HEADING = "## [Unreleased]";
const NOT_PUBLISHED = /^Not published to npm; first available in (\d+\.\d+\.\d+)\.$/;
const LINK_DEFINITION = /^\[([^\]\n]+)\]: (\S+)$/;
const DOCS_PIN = /"@lumenwipe\/sdk":\s*"([^"\n]*)"/g;
const BRANCH_NAME = /^[A-Za-z0-9._/]+$/;

export type Mode = "offline" | "pr" | "publish";

export interface DocsFile {
  path: string;
  text: string;
}

export interface RegistryState {
  versions: string[];
  latest: string;
}

export interface AgreementInput {
  mode: Mode;
  packageVersion: string;
  sdkVersion: string;
  changelog: string;
  docs: DocsFile[];
  /** pr and publish only. */
  npm?: RegistryState;
  /** pr and publish only: the `sdk-v*` tags on the remote. */
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

export function parseChangelog(text: string): ParsedChangelog {
  const entries: ChangelogEntry[] = [];
  const links = new Map<string, string>();
  const problems: string[] = [];
  let sawUnreleased = false;
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
      if (current) {
        current.lines.push(line);
        const marker = NOT_PUBLISHED.exec(line);
        if (marker) current.entry.firstAvailableIn = marker[1];
      }
      continue;
    }
    close();
    if (line === UNRELEASED_HEADING) {
      if (sawUnreleased) problems.push("## [Unreleased] appears twice");
      if (entries.length > 0) problems.push("## [Unreleased] must come before every version");
      sawUnreleased = true;
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
  return { entries, links, problems };
}

/** The exact link definitions the changelog must carry: published versions only. */
export function expectedLinks(entries: ChangelogEntry[]): Map<string, string> {
  const shipped = entries.filter((e) => e.firstAvailableIn === null).map((e) => e.version);
  const links = new Map<string, string>();
  if (shipped.length === 0) return links;
  links.set("Unreleased", `${REPO_URL}/compare/sdk-v${shipped[0]}...HEAD`);
  shipped.forEach((version, i) => {
    const previous = shipped[i + 1];
    links.set(
      version,
      previous
        ? `${REPO_URL}/compare/sdk-v${previous}...sdk-v${version}`
        : `${REPO_URL}/tree/sdk-v${version}`
    );
  });
  return links;
}

export function docsPins(docs: DocsFile[]): { path: string; range: string }[] {
  const pins: { path: string; range: string }[] = [];
  for (const file of docs) {
    for (const match of file.text.matchAll(DOCS_PIN))
      pins.push({ path: file.path, range: match[1] });
  }
  return pins;
}

function checkFiles(input: AgreementInput, verdict: Verdict, parsed: ParsedChangelog): void {
  const { errors } = verdict;
  const version = input.packageVersion;
  if (!parseSemver(version)) {
    errors.push(`package.json version "${version}" is not X.Y.Z`);
    return;
  }
  if (input.sdkVersion !== version) {
    errors.push(`SDK_VERSION is "${input.sdkVersion}" but package.json is "${version}"`);
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
    errors.push(`CHANGELOG.md has no heading for ${version}`);
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

  const expected = expectedLinks(entries);
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

  const [major, minor] = parseSemver(version)!;
  const wanted = `~${major}.${minor}.0`;
  const pins = docsPins(input.docs);
  if (pins.length === 0) errors.push(`no docs page pins "${PACKAGE_NAME}"`);
  for (const pin of pins) {
    if (pin.range !== wanted) {
      errors.push(`${pin.path} pins "${PACKAGE_NAME}": "${pin.range}", expected "${wanted}"`);
    }
  }
}

function checkRegistry(input: AgreementInput, verdict: Verdict, entries: ChangelogEntry[]): void {
  const { errors, warnings } = verdict;
  const npm = input.npm;
  const tags = input.tags;
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
    const match = TAG_PATTERN.exec(tag);
    if (match) tagged.add(match[1]);
  }

  if (!parseSemver(npm.latest)) {
    errors.push(`npm latest "${npm.latest}" is not X.Y.Z`);
    return;
  }
  const highest = [...published].sort(compareSemver).pop();
  if (highest && highest !== npm.latest) {
    errors.push(`npm latest is ${npm.latest} but ${highest} is published`);
  }

  for (const v of published) {
    const entry = byVersion.get(v);
    if (!entry) errors.push(`${v} is on npm but has no CHANGELOG.md heading`);
    else if (entry.firstAvailableIn !== null) {
      errors.push(`CHANGELOG.md marks ${v} as not published, but npm has it`);
    }
    if (!tagged.has(v)) errors.push(`${v} is on npm but tag sdk-v${v} does not exist`);
  }
  for (const v of tagged) {
    if (!byVersion.has(v)) errors.push(`tag sdk-v${v} has no CHANGELOG.md heading`);
    else if (byVersion.get(v)!.firstAvailableIn !== null) {
      errors.push(`tag sdk-v${v} exists, but CHANGELOG.md marks ${v} as not published`);
    }
  }

  if (compareSemver(npm.latest, version) > 0) {
    errors.push(`npm latest ${npm.latest} is ahead of package.json ${version}`);
  }

  const releasePr =
    input.mode === "pr" && input.baseVersion !== undefined && input.baseVersion !== version;

  // Merged but not published yet: a release waiting for its tag. Never a failure. The version a
  // release PR introduces, or the one being published, is checked on its own below instead.
  for (const entry of entries) {
    if (entry.firstAvailableIn !== null || onNpm.has(entry.version)) continue;
    if (entry.version === version && (releasePr || input.mode === "publish")) continue;
    const tagNote = tagged.has(entry.version)
      ? ` Tag sdk-v${entry.version} exists, so its publish is running or failed.`
      : "";
    warnings.push(
      `${entry.version} is in CHANGELOG.md but not on npm yet: a merged release waiting to be published.${tagNote}`
    );
  }

  if (releasePr && input.baseVersion !== undefined) {
    if (!parseSemver(input.baseVersion)) {
      errors.push(`the base branch's version "${input.baseVersion}" is not X.Y.Z`);
    } else if (compareSemver(version, input.baseVersion) <= 0) {
      errors.push(`release ${version} is not greater than the base branch's ${input.baseVersion}`);
    }
    if (onNpm.has(version)) errors.push(`release ${version} is already on npm`);
    else if (compareSemver(version, npm.latest) <= 0) {
      errors.push(`release ${version} is not greater than npm latest ${npm.latest}`);
    }
    if (tagged.has(version)) errors.push(`release ${version} already has tag sdk-v${version}`);
  }

  if (input.mode === "publish") {
    const match = TAG_PATTERN.exec(input.tag ?? "");
    if (!match) errors.push(`tag "${input.tag ?? ""}" is not sdk-vX.Y.Z`);
    else if (match[1] !== version) {
      errors.push(`tag ${input.tag} does not match package.json version ${version}`);
    }
    if (input.tagOnMain !== true) errors.push(`tag ${input.tag ?? ""} is not on main`);
    if (input.headIsTag !== true)
      errors.push(`the checked-out commit is not tag ${input.tag ?? ""}`);
    if (onNpm.has(version)) errors.push(`${version} is already on npm`);
    else if (compareSemver(version, npm.latest) <= 0) {
      errors.push(`${version} is not greater than npm latest ${npm.latest}`);
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

const ROOT = resolve(import.meta.dir, "..");
const SDK = join(ROOT, "packages/sdk");

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

function docsFiles(): DocsFile[] {
  const paths = ["README.md", "packages/sdk/README.md"];
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

function readFiles(): Pick<AgreementInput, "packageVersion" | "sdkVersion" | "changelog" | "docs"> {
  const manifest = JSON.parse(readFileSync(join(SDK, "package.json"), "utf8")) as {
    version: string;
  };
  const source = readFileSync(join(SDK, "src/version.ts"), "utf8");
  const sdkVersion = /export const SDK_VERSION = "([^"\n]*)";/.exec(source)?.[1] ?? "(missing)";
  return {
    packageVersion: manifest.version,
    sdkVersion,
    changelog: readFileSync(join(SDK, "CHANGELOG.md"), "utf8"),
    docs: docsFiles(),
  };
}

async function remoteState(): Promise<Pick<AgreementInput, "npm" | "tags">> {
  const npm = await withRetries("npm view", () =>
    parseNpmView(run("npm", ["view", PACKAGE_NAME, "versions", "dist-tags", "--json"]))
  );
  const tags = await withRetries("git ls-remote", () =>
    parseLsRemote(run("git", ["ls-remote", "--tags", "--refs", "origin", "refs/tags/sdk-v*"]))
  );
  return { npm, tags };
}

function baseVersion(): string | undefined {
  const ref = process.env.BASE_REF ?? "";
  if (ref === "") return undefined;
  if (!BRANCH_NAME.test(ref) || ref.startsWith(".") || ref.includes("..")) {
    throw new Error(`BASE_REF "${ref}" is not a branch name`);
  }
  run("git", ["fetch", "--no-tags", "--depth=1", "origin", `refs/heads/${ref}`]);
  const manifest = run("git", ["show", "FETCH_HEAD:packages/sdk/package.json"]);
  return (JSON.parse(manifest) as { version: string }).version;
}

function report(verdict: Verdict): void {
  const ci = process.env.GITHUB_ACTIONS === "true";
  for (const warning of verdict.warnings)
    console.log(ci ? `::warning::${warning}` : `warning: ${warning}`);
  for (const error of verdict.errors) console.log(ci ? `::error::${error}` : `error: ${error}`);
  if (verdict.errors.length === 0)
    console.log("SDK version, changelog, docs pin, tags and npm agree.");
}

async function main(argv: string[]): Promise<number> {
  const [mode, arg] = argv;
  if (mode === "notes") {
    if (!arg || !parseSemver(arg)) {
      console.error("usage: sdk-release.ts notes X.Y.Z");
      return 2;
    }
    const notes = releaseNotes(readFileSync(join(SDK, "CHANGELOG.md"), "utf8"), arg);
    if (notes === null) {
      console.error(`CHANGELOG.md has no ${arg} heading`);
      return 1;
    }
    console.log(notes);
    return 0;
  }
  if (mode !== "offline" && mode !== "pr" && mode !== "publish") {
    console.error("usage: sdk-release.ts offline | pr | publish | notes X.Y.Z");
    return 2;
  }

  const input: AgreementInput = { mode, ...readFiles() };
  if (mode === "pr") {
    Object.assign(input, await remoteState(), { baseVersion: baseVersion() });
  }
  if (mode === "publish") {
    const tag = process.env.TAG ?? "";
    input.tag = tag;
    if (TAG_PATTERN.test(tag)) {
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
    Object.assign(input, await remoteState());
  }

  const verdict = checkAgreement(input);
  report(verdict);
  return verdict.errors.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
