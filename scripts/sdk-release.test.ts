import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkAgreement,
  compareSemver,
  expectedLinks,
  parseChangelog,
  parseLsRemote,
  parseNpmView,
  releaseNotes,
  type AgreementInput,
  type Verdict,
} from "./sdk-release";

const R = "https://github.com/LumenWipe/lumenwipe";

// Mirrors the real history: 0.4.0 never shipped on its own and is first in 0.5.1.
const CHANGELOG = `# Changelog

## [Unreleased]

### Added

- Something new.

## [0.5.1] - 2026-10-10

### Added

- A fix.

## [0.4.0] - 2026-10-09

Not published to npm; first available in 0.5.1.

### Added

- A feature.

## [0.2.0] - 2026-09-23

- Second.

## [0.1.0] - 2026-09-07

- First.

[Unreleased]: ${R}/compare/sdk-v0.5.1...HEAD
[0.5.1]: ${R}/compare/sdk-v0.2.0...sdk-v0.5.1
[0.2.0]: ${R}/compare/sdk-v0.1.0...sdk-v0.2.0
[0.1.0]: ${R}/tree/sdk-v0.1.0
`;

const DOCS = [{ path: "docs/sdk/versioning.mdx", text: `{ "@lumenwipe/sdk": "~0.5.0" }` }];
const NPM = { versions: ["0.1.0", "0.2.0", "0.5.1"], latest: "0.5.1" };
const TAGS = ["sdk-v0.1.0", "sdk-v0.2.0", "sdk-v0.5.1"];

/** CHANGELOG with 0.6.0 released on top of the fixture above. */
function released(version = "0.6.0"): string {
  return CHANGELOG.replace(
    "## [0.5.1]",
    `## [${version}] - 2026-11-01\n\n### Added\n\n- Released.\n\n## [0.5.1]`
  ).replace(
    `[Unreleased]: ${R}/compare/sdk-v0.5.1...HEAD`,
    `[Unreleased]: ${R}/compare/sdk-v${version}...HEAD\n[${version}]: ${R}/compare/sdk-v0.5.1...sdk-v${version}`
  );
}

function input(over: Partial<AgreementInput> = {}): AgreementInput {
  return {
    mode: "offline",
    packageVersion: "0.5.1",
    sdkVersion: "0.5.1",
    changelog: CHANGELOG,
    docs: DOCS,
    ...over,
  };
}

function pr(over: Partial<AgreementInput> = {}): AgreementInput {
  return input({ mode: "pr", npm: NPM, tags: TAGS, baseVersion: "0.5.1", ...over });
}

function publish(over: Partial<AgreementInput> = {}): AgreementInput {
  return input({
    mode: "publish",
    packageVersion: "0.6.0",
    sdkVersion: "0.6.0",
    changelog: released(),
    docs: [{ path: "docs/sdk/versioning.mdx", text: `"@lumenwipe/sdk": "~0.6.0"` }],
    npm: NPM,
    tags: [...TAGS, "sdk-v0.6.0"],
    tag: "sdk-v0.6.0",
    tagOnMain: true,
    headIsTag: true,
    ...over,
  });
}

function expectError(verdict: Verdict, fragment: string): void {
  expect(verdict.errors.some((e) => e.includes(fragment))).toBe(true);
}

describe("checkAgreement: files (offline)", () => {
  test("the agreeing fixture passes with no warnings", () => {
    expect(checkAgreement(input())).toEqual({ errors: [], warnings: [] });
  });

  test("a version with no changelog heading fails", () => {
    const verdict = checkAgreement(input({ packageVersion: "0.6.0", sdkVersion: "0.6.0" }));
    expectError(verdict, "newest heading is 0.5.1 but package.json is 0.6.0");
  });

  test("SDK_VERSION differing from package.json fails", () => {
    expectError(checkAgreement(input({ sdkVersion: "0.5.0" })), 'SDK_VERSION is "0.5.0"');
  });

  test("a non X.Y.Z version fails", () => {
    expectError(
      checkAgreement(input({ packageVersion: "0.6.0-beta.1", sdkVersion: "0.6.0-beta.1" })),
      "is not X.Y.Z"
    );
  });

  test("unordered headings fail", () => {
    const swapped = CHANGELOG.replace("## [0.2.0] - 2026-09-23", "## [0.9.0] - 2026-09-23");
    expectError(checkAgreement(input({ changelog: swapped })), "0.4.0 is listed above 0.9.0");
  });

  test("a duplicate heading fails", () => {
    const twice = CHANGELOG.replace("## [0.2.0] - 2026-09-23", "## [0.1.0] - 2026-09-23");
    expectError(checkAgreement(input({ changelog: twice })), "0.1.0 has two headings");
  });

  test("a malformed heading fails", () => {
    const bad = CHANGELOG.replace("## [0.2.0] - 2026-09-23", "## 0.2.0");
    expectError(checkAgreement(input({ changelog: bad })), 'malformed heading "## 0.2.0"');
  });

  test("[Unreleased] missing or below a version fails", () => {
    const none = CHANGELOG.replace("## [Unreleased]\n", "");
    expectError(checkAgreement(input({ changelog: none })), "no ## [Unreleased] heading");
    const below = none.replace("## [0.2.0]", "## [Unreleased]\n\n## [0.2.0]");
    expectError(checkAgreement(input({ changelog: below })), "must come before every version");
  });

  test("the current version marked as not published fails", () => {
    const marked = CHANGELOG.replace(
      "## [0.5.1] - 2026-10-10\n",
      "## [0.5.1] - 2026-10-10\n\nNot published to npm; first available in 0.5.1.\n"
    );
    expectError(
      checkAgreement(input({ changelog: marked })),
      "the current version, as not published"
    );
  });

  test("a not-published marker naming the wrong release fails", () => {
    const wrong = CHANGELOG.replace("first available in 0.5.1", "first available in 0.7.0");
    expectError(checkAgreement(input({ changelog: wrong })), "says it first shipped in 0.7.0");
  });

  test("a link for an unpublished version, or a wrong or missing link, fails", () => {
    const extra = `${CHANGELOG}[0.4.0]: ${R}/compare/sdk-v0.2.0...sdk-v0.4.0\n`;
    expectError(
      checkAgreement(input({ changelog: extra })),
      "link [0.4.0] has no published heading"
    );
    const wrong = CHANGELOG.replace(`${R}/tree/sdk-v0.1.0`, "https://example.com/sdk-v0.1.0");
    expectError(checkAgreement(input({ changelog: wrong })), "link [0.1.0] must be");
    const missing = CHANGELOG.replace(`[0.2.0]: ${R}/compare/sdk-v0.1.0...sdk-v0.2.0\n`, "");
    expectError(checkAgreement(input({ changelog: missing })), "link [0.2.0] must be");
  });

  test("a docs pin on another minor fails", () => {
    const old = [{ path: "docs/sdk/versioning.mdx", text: `"@lumenwipe/sdk": "~0.3.0"` }];
    expectError(
      checkAgreement(input({ docs: old })),
      'pins "@lumenwipe/sdk": "~0.3.0", expected "~0.5.0"'
    );
  });

  test("a docs pin that is not a tilde range on X.Y.0 fails", () => {
    for (const range of ["^0.5.0", "0.5.1", "~0.5.1"]) {
      const docs = [{ path: "README.md", text: `"@lumenwipe/sdk": "${range}"` }];
      expectError(checkAgreement(input({ docs })), `"${range}", expected "~0.5.0"`);
    }
  });

  test("no docs pin at all fails", () => {
    expectError(checkAgreement(input({ docs: [] })), "no docs page pins");
  });
});

describe("checkAgreement: npm and tags (pr)", () => {
  test("an ordinary PR on a published version passes", () => {
    expect(checkAgreement(pr())).toEqual({ errors: [], warnings: [] });
  });

  test("a merged release not on npm yet is a warning, never an error", () => {
    const verdict = checkAgreement(
      pr({
        packageVersion: "0.6.0",
        sdkVersion: "0.6.0",
        baseVersion: "0.6.0",
        changelog: released(),
        docs: [{ path: "d.mdx", text: `"@lumenwipe/sdk": "~0.6.0"` }],
      })
    );
    expect(verdict.errors).toEqual([]);
    expect(verdict.warnings).toHaveLength(1);
    expect(verdict.warnings[0]).toContain("0.6.0 is in CHANGELOG.md but not on npm yet");
  });

  test("a tag pushed for a version npm does not have yet is a warning", () => {
    const verdict = checkAgreement(
      pr({
        packageVersion: "0.6.0",
        sdkVersion: "0.6.0",
        baseVersion: "0.6.0",
        changelog: released(),
        docs: [{ path: "d.mdx", text: `"@lumenwipe/sdk": "~0.6.0"` }],
        tags: [...TAGS, "sdk-v0.6.0"],
      })
    );
    expect(verdict.errors).toEqual([]);
    expect(verdict.warnings[0]).toContain("Tag sdk-v0.6.0 exists");
  });

  test("a release PR on top of an unpublished base warns about the base and passes", () => {
    const changelog = released("0.6.0")
      .replace("## [0.6.0]", `## [0.7.0] - 2026-11-05\n\n- Next.\n\n## [0.6.0]`)
      .replace(
        `[Unreleased]: ${R}/compare/sdk-v0.6.0...HEAD`,
        `[Unreleased]: ${R}/compare/sdk-v0.7.0...HEAD\n[0.7.0]: ${R}/compare/sdk-v0.6.0...sdk-v0.7.0`
      );
    const verdict = checkAgreement(
      pr({
        packageVersion: "0.7.0",
        sdkVersion: "0.7.0",
        baseVersion: "0.6.0",
        changelog,
        docs: [{ path: "d.mdx", text: `"@lumenwipe/sdk": "~0.7.0"` }],
      })
    );
    expect(verdict.errors).toEqual([]);
    expect(verdict.warnings).toHaveLength(1);
    expect(verdict.warnings[0]).toContain("0.6.0 is in CHANGELOG.md but not on npm yet");
  });

  const release060 = {
    packageVersion: "0.6.0",
    sdkVersion: "0.6.0",
    changelog: released(),
    docs: [{ path: "d.mdx", text: `"@lumenwipe/sdk": "~0.6.0"` }],
  };

  test("a release PR passes with no warnings", () => {
    expect(checkAgreement(pr(release060))).toEqual({ errors: [], warnings: [] });
  });

  test("a release PR whose version is already on npm fails", () => {
    const npm = { versions: [...NPM.versions, "0.6.0"], latest: "0.6.0" };
    expectError(
      checkAgreement(pr({ ...release060, npm, tags: [...TAGS, "sdk-v0.6.0"] })),
      "release 0.6.0 is already on npm"
    );
  });

  test("a release PR not greater than npm latest fails", () => {
    const npm = { versions: [...NPM.versions], latest: "0.5.1" };
    const changelog = CHANGELOG.replace(
      "## [0.4.0]",
      "## [0.4.5] - 2026-10-09\n\n- Late.\n\n## [0.4.0]"
    );
    const verdict = checkAgreement(
      pr({ packageVersion: "0.4.5", sdkVersion: "0.4.5", baseVersion: "0.4.0", changelog, npm })
    );
    expectError(verdict, "release 0.4.5 is not greater than npm latest 0.5.1");
  });

  test("a release PR not greater than the base branch fails", () => {
    expectError(
      checkAgreement(pr({ ...release060, baseVersion: "0.7.0" })),
      "release 0.6.0 is not greater than the base branch's 0.7.0"
    );
  });

  test("a release PR whose tag already exists fails", () => {
    expectError(
      checkAgreement(pr({ ...release060, tags: [...TAGS, "sdk-v0.6.0"] })),
      "release 0.6.0 already has tag sdk-v0.6.0"
    );
  });

  test("npm latest ahead of package.json fails", () => {
    const npm = { versions: [...NPM.versions, "0.6.0"], latest: "0.6.0" };
    const verdict = checkAgreement(pr({ npm, tags: [...TAGS, "sdk-v0.6.0"] }));
    expectError(verdict, "npm latest 0.6.0 is ahead of package.json 0.5.1");
  });

  test("a published version with no heading, or marked unpublished, fails", () => {
    const npm = { versions: [...NPM.versions, "0.3.0", "0.4.0"], latest: "0.5.1" };
    const tags = [...TAGS, "sdk-v0.3.0", "sdk-v0.4.0"];
    const verdict = checkAgreement(pr({ npm, tags }));
    expectError(verdict, "0.3.0 is on npm but has no CHANGELOG.md heading");
    expectError(verdict, "CHANGELOG.md marks 0.4.0 as not published, but npm has it");
  });

  test("a published version without its tag fails", () => {
    expectError(
      checkAgreement(pr({ tags: ["sdk-v0.1.0", "sdk-v0.5.1"] })),
      "0.2.0 is on npm but tag sdk-v0.2.0 does not exist"
    );
  });

  test("a tag for a version with no heading, or marked unpublished, fails", () => {
    const verdict = checkAgreement(pr({ tags: [...TAGS, "sdk-v0.3.0", "sdk-v0.4.0"] }));
    expectError(verdict, "tag sdk-v0.3.0 has no CHANGELOG.md heading");
    expectError(verdict, "tag sdk-v0.4.0 exists, but CHANGELOG.md marks 0.4.0 as not published");
  });

  test("a latest dist-tag below the highest published version fails", () => {
    const npm = { versions: [...NPM.versions], latest: "0.2.0" };
    expectError(checkAgreement(pr({ npm })), "npm latest is 0.2.0 but 0.5.1 is published");
  });

  test("pr mode without registry data fails instead of passing silently", () => {
    expectError(checkAgreement(pr({ npm: undefined })), "needs the npm state");
  });
});

describe("checkAgreement: publish", () => {
  test("publishing the merged, tagged release passes", () => {
    expect(checkAgreement(publish())).toEqual({ errors: [], warnings: [] });
  });

  test("a tag that is not on main fails", () => {
    expectError(checkAgreement(publish({ tagOnMain: false })), "tag sdk-v0.6.0 is not on main");
    expectError(checkAgreement(publish({ tagOnMain: undefined })), "is not on main");
  });

  test("a checkout that is not the tag fails", () => {
    expectError(checkAgreement(publish({ headIsTag: false })), "checked-out commit is not tag");
  });

  test("a tag that does not match package.json fails", () => {
    expectError(
      checkAgreement(publish({ tag: "sdk-v0.6.1" })),
      "tag sdk-v0.6.1 does not match package.json version 0.6.0"
    );
  });

  test("a malformed tag fails", () => {
    for (const tag of ["v0.6.0", "sdk-v0.6", "sdk-v0.6.0-rc.1", "sdk-v0.6.0\nx", ""]) {
      expectError(checkAgreement(publish({ tag })), "is not sdk-vX.Y.Z");
    }
  });

  test("a version already on npm fails", () => {
    const npm = { versions: [...NPM.versions, "0.6.0"], latest: "0.6.0" };
    expectError(checkAgreement(publish({ npm })), "0.6.0 is already on npm");
  });

  test("a version not greater than npm latest fails", () => {
    const npm = { versions: ["0.1.0", "0.2.0", "0.5.1", "0.7.0"], latest: "0.7.0" };
    const verdict = checkAgreement(publish({ npm, tags: [...TAGS, "sdk-v0.6.0", "sdk-v0.7.0"] }));
    expectError(verdict, "0.6.0 is not greater than npm latest 0.7.0");
  });
});

describe("helpers", () => {
  test("compareSemver orders numerically, not as text", () => {
    expect(compareSemver("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareSemver("0.9.0", "0.10.0")).toBeLessThan(0);
    expect(compareSemver("1.0.0", "0.99.99")).toBeGreaterThan(0);
    expect(compareSemver("0.5.1", "0.5.1")).toBe(0);
    expect(() => compareSemver("0.5", "0.5.1")).toThrow();
  });

  test("expectedLinks skips unpublished versions", () => {
    const links = expectedLinks(parseChangelog(CHANGELOG).entries);
    expect([...links.keys()]).toEqual(["Unreleased", "0.5.1", "0.2.0", "0.1.0"]);
    expect(links.get("0.5.1")).toBe(`${R}/compare/sdk-v0.2.0...sdk-v0.5.1`);
  });

  test("releaseNotes returns one version's section", () => {
    expect(releaseNotes(CHANGELOG, "0.5.1")).toBe("### Added\n\n- A fix.");
    expect(releaseNotes(CHANGELOG, "0.9.9")).toBeNull();
  });

  test("parseNpmView accepts one version or many and needs latest", () => {
    expect(
      parseNpmView(JSON.stringify({ versions: "0.1.0", "dist-tags": { latest: "0.1.0" } }))
    ).toEqual({
      versions: ["0.1.0"],
      latest: "0.1.0",
    });
    expect(() => parseNpmView(JSON.stringify({ versions: [] }))).toThrow();
  });

  test("parseLsRemote reads tag names", () => {
    expect(parseLsRemote("abc\trefs/tags/sdk-v0.1.0\ndef\trefs/tags/sdk-v0.2.0\n")).toEqual([
      "sdk-v0.1.0",
      "sdk-v0.2.0",
    ]);
  });
});

describe("the repository agrees with itself", () => {
  test("package.json, SDK_VERSION, CHANGELOG.md and the docs pin agree", () => {
    const root = join(import.meta.dir, "..");
    const read = (path: string): string => readFileSync(join(root, path), "utf8");
    const version = (JSON.parse(read("packages/sdk/package.json")) as { version: string }).version;
    const sdkVersion = /SDK_VERSION = "([^"]+)"/.exec(read("packages/sdk/src/version.ts"))?.[1];
    const verdict = checkAgreement({
      mode: "offline",
      packageVersion: version,
      sdkVersion: sdkVersion ?? "",
      changelog: read("packages/sdk/CHANGELOG.md"),
      docs: [{ path: "docs/sdk/versioning.mdx", text: read("docs/sdk/versioning.mdx") }],
    });
    expect(verdict.errors).toEqual([]);
  });
});

