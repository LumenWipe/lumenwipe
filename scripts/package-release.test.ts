import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { YAML } from "bun";
import {
  bundleInputs,
  changelogVerdict,
  checkAgreement,
  compareSemver,
  expectedLinks,
  isNpmNotFound,
  isPackageId,
  PACKAGES,
  parseChangelog,
  parseLsRemote,
  parseNpmView,
  releaseNotes,
  shippedChanges,
  tagVersion,
  type AgreementInput,
  type ChangeSet,
  type Verdict,
} from "./package-release";

const ROOT = join(import.meta.dir, "..");

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
    pkg: PACKAGES.sdk,
    mode: "offline",
    packageVersion: "0.5.1",
    versionConstant: "0.5.1",
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
    versionConstant: "0.6.0",
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
    const verdict = checkAgreement(input({ packageVersion: "0.6.0", versionConstant: "0.6.0" }));
    expectError(verdict, "newest heading is 0.5.1 but package.json is 0.6.0");
  });

  test("SDK_VERSION differing from package.json fails", () => {
    expectError(checkAgreement(input({ versionConstant: "0.5.0" })), 'SDK_VERSION is "0.5.0"');
  });

  test("a non X.Y.Z version fails", () => {
    expectError(
      checkAgreement(input({ packageVersion: "0.6.0-beta.1", versionConstant: "0.6.0-beta.1" })),
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
        versionConstant: "0.6.0",
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
        versionConstant: "0.6.0",
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
        versionConstant: "0.7.0",
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
    versionConstant: "0.6.0",
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
      pr({
        packageVersion: "0.4.5",
        versionConstant: "0.4.5",
        baseVersion: "0.4.0",
        changelog,
        npm,
      })
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
    const links = expectedLinks(PACKAGES.sdk, parseChangelog(CHANGELOG).entries);
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

  test("isNpmNotFound is true only for npm's not-found error", () => {
    expect(isNpmNotFound(JSON.stringify({ error: { code: "E404", summary: "Not Found" } }))).toBe(
      true
    );
    expect(isNpmNotFound(JSON.stringify({ error: { code: "ETIMEDOUT" } }))).toBe(false);
    expect(isNpmNotFound(JSON.stringify({ error: { code: "E500" } }))).toBe(false);
    expect(isNpmNotFound(JSON.stringify({ versions: ["0.1.0"] }))).toBe(false);
    expect(isNpmNotFound("null")).toBe(false);
    expect(isNpmNotFound("npm error code E404")).toBe(false);
    expect(isNpmNotFound("")).toBe(false);
  });

  test("parseLsRemote reads tag names", () => {
    expect(parseLsRemote("abc\trefs/tags/sdk-v0.1.0\ndef\trefs/tags/sdk-v0.2.0\n")).toEqual([
      "sdk-v0.1.0",
      "sdk-v0.2.0",
    ]);
  });

  test("tagVersion accepts exactly <prefix>X.Y.Z for its own package", () => {
    expect(tagVersion(PACKAGES.sdk, "sdk-v0.9.0")).toBe("0.9.0");
    expect(tagVersion(PACKAGES.verify, "verify-v0.1.0")).toBe("0.1.0");
    for (const tag of [
      "verify-v0.1.0",
      "sdk-v0.9",
      "sdk-v0.9.0-rc.1",
      "sdk-v01.0.0",
      "xsdk-v0.9.0",
    ])
      expect(tagVersion(PACKAGES.sdk, tag)).toBeNull();
    expect(tagVersion(PACKAGES.verify, "sdk-v0.1.0")).toBeNull();
  });

  test("isPackageId accepts the two published packages only", () => {
    expect(isPackageId("sdk")).toBe(true);
    expect(isPackageId("verify")).toBe(true);
    for (const id of ["types", "web", "", "SDK", undefined]) expect(isPackageId(id)).toBe(false);
  });
});

const UNPUBLISHED = { versions: [], latest: null };

// The verifier before its first release: everything is still under [Unreleased].
const VERIFY_FIRST = `# Changelog

## [Unreleased]

### Added

- First.
`;

// The same after the release PR for 0.1.0 merged.
const VERIFY_RELEASED = `# Changelog

## [Unreleased]

## [0.1.0] - 2026-11-10

### Added

- First.

[Unreleased]: ${R}/compare/verify-v0.1.0...HEAD
[0.1.0]: ${R}/tree/verify-v0.1.0
`;

function verify(over: Partial<AgreementInput> = {}): AgreementInput {
  return {
    pkg: PACKAGES.verify,
    mode: "offline",
    packageVersion: "0.1.0",
    changelog: VERIFY_FIRST,
    docs: [],
    ...over,
  };
}

describe("checkAgreement: a package before its first release (verify)", () => {
  test("offline: no released heading yet is a warning, not an error", () => {
    const verdict = checkAgreement(verify());
    expect(verdict.errors).toEqual([]);
    expect(verdict.warnings).toHaveLength(1);
    expect(verdict.warnings[0]).toContain("the first release is still to be cut");
  });

  test("needs no version constant and no docs pin", () => {
    expect(PACKAGES.verify.versionConstant).toBeNull();
    expect(PACKAGES.verify.docsPin).toBeNull();
    expect(checkAgreement(verify({ docs: [] })).errors).toEqual([]);
  });

  test("pr: a package npm has never seen passes with the warning", () => {
    const verdict = checkAgreement(
      verify({ mode: "pr", npm: UNPUBLISHED, tags: [], baseVersion: "0.1.0" })
    );
    expect(verdict.errors).toEqual([]);
    expect(verdict.warnings).toHaveLength(1);
    expect(verdict.warnings[0]).toContain("the first release is still to be cut");
  });

  test("pr: the other package's tags are not this package's", () => {
    const verdict = checkAgreement(
      verify({ mode: "pr", npm: UNPUBLISHED, tags: ["sdk-v0.1.0", "sdk-v0.9.0"] })
    );
    expect(verdict.errors).toEqual([]);
  });

  test("pr: a tag for another version while npm has none fails", () => {
    const verdict = checkAgreement(
      verify({
        mode: "pr",
        packageVersion: "0.2.0",
        npm: UNPUBLISHED,
        tags: ["verify-v0.1.0"],
        changelog: VERIFY_RELEASED,
      })
    );
    expectError(verdict, "tag verify-v0.1.0 exists, but npm has no version of @lumenwipe/verify");
  });

  test("publish: no released heading fails", () => {
    const verdict = checkAgreement(
      verify({
        mode: "publish",
        npm: UNPUBLISHED,
        tags: ["verify-v0.1.0"],
        tag: "verify-v0.1.0",
        tagOnMain: true,
        headIsTag: true,
      })
    );
    expectError(verdict, "CHANGELOG.md has no heading for 0.1.0");
    expect(verdict.warnings).toEqual([]);
  });

  test("the released changelog passes offline with no warnings", () => {
    expect(checkAgreement(verify({ changelog: VERIFY_RELEASED }))).toEqual({
      errors: [],
      warnings: [],
    });
  });

  test("verify links must use the verify-v prefix", () => {
    const sdkLinks = VERIFY_RELEASED.replaceAll("verify-v", "sdk-v");
    expectError(checkAgreement(verify({ changelog: sdkLinks })), "link [0.1.0] must be");
    const links = expectedLinks(PACKAGES.verify, parseChangelog(VERIFY_RELEASED).entries);
    expect(links.get("Unreleased")).toBe(`${R}/compare/verify-v0.1.0...HEAD`);
    expect(links.get("0.1.0")).toBe(`${R}/tree/verify-v0.1.0`);
  });

  test("pr after the release PR merged: not on npm yet is a warning", () => {
    const verdict = checkAgreement(
      verify({
        mode: "pr",
        npm: UNPUBLISHED,
        tags: [],
        baseVersion: "0.1.0",
        changelog: VERIFY_RELEASED,
      })
    );
    expect(verdict.errors).toEqual([]);
    expect(verdict.warnings).toHaveLength(1);
    expect(verdict.warnings[0]).toContain("0.1.0 is in CHANGELOG.md but not on npm yet");
  });

  test("pr while the first tag's publish runs or failed: a warning naming the tag", () => {
    const verdict = checkAgreement(
      verify({ mode: "pr", npm: UNPUBLISHED, tags: ["verify-v0.1.0"], changelog: VERIFY_RELEASED })
    );
    expect(verdict.errors).toEqual([]);
    expect(verdict.warnings[0]).toContain("Tag verify-v0.1.0 exists");
  });

  const first = (over: Partial<AgreementInput> = {}): AgreementInput =>
    verify({
      mode: "publish",
      changelog: VERIFY_RELEASED,
      npm: UNPUBLISHED,
      tags: ["verify-v0.1.0"],
      tag: "verify-v0.1.0",
      tagOnMain: true,
      headIsTag: true,
      ...over,
    });

  test("publish: the first release to a package npm has never seen passes", () => {
    expect(checkAgreement(first())).toEqual({ errors: [], warnings: [] });
  });

  test("publish: an sdk tag cannot publish verify, nor a verify tag the SDK", () => {
    expectError(checkAgreement(first({ tag: "sdk-v0.1.0" })), "is not verify-vX.Y.Z");
    expectError(checkAgreement(publish({ tag: "verify-v0.6.0" })), "is not sdk-vX.Y.Z");
  });

  test("a not-found answer for the SDK, which has tags, fails instead of passing", () => {
    const verdict = checkAgreement(pr({ npm: UNPUBLISHED }));
    expectError(verdict, "tag sdk-v0.1.0 exists, but npm has no version of @lumenwipe/sdk");
    expectError(verdict, "tag sdk-v0.2.0 exists, but npm has no version of @lumenwipe/sdk");
  });
});

const set = (over: Partial<ChangeSet>): ChangeSet => ({
  changed: [],
  onBase: () => true,
  ...over,
});

const VERIFY_MANIFEST = JSON.stringify({
  name: "@lumenwipe/verify",
  version: "0.1.0",
  files: ["dist", "vectors", "README.md"],
  peerDependencies: { "@stellar/stellar-sdk": "17.4.0" },
  devDependencies: { tsup: "^9.0.0" },
});

const INPUTS = [
  "apps/api/src/config/exchange-registry.json",
  "apps/web/lib/stellar/verify.ts",
  "packages/verify/src/index.ts",
];

describe("shippedChanges", () => {
  test("sdk: a source change counts, a test or doc change does not", () => {
    expect(shippedChanges(PACKAGES.sdk, set({ changed: ["packages/sdk/src/client.ts"] }))).toEqual([
      "packages/sdk/src/",
    ]);
    expect(
      shippedChanges(
        PACKAGES.sdk,
        set({ changed: ["packages/sdk/tests/unit/client.test.ts", "packages/sdk/README.md"] })
      )
    ).toEqual([]);
  });

  test("sdk: the API report counts only when it already existed on the base", () => {
    const changed = ["packages/sdk/etc/sdk.api.md"];
    expect(shippedChanges(PACKAGES.sdk, set({ changed }))).toEqual(changed);
    expect(shippedChanges(PACKAGES.sdk, set({ changed, onBase: () => false }))).toEqual([]);
  });

  test("sdk: a web or registry change is not an SDK change", () => {
    const changed = [
      "apps/api/src/config/exchange-registry.json",
      "apps/web/lib/stellar/verify.ts",
    ];
    expect(shippedChanges(PACKAGES.sdk, set({ changed, bundleInputs: INPUTS }))).toEqual([]);
  });

  test("verify: a file compiled into the bundle counts, wherever it lives", () => {
    for (const path of INPUTS.slice(0, 2)) {
      expect(
        shippedChanges(PACKAGES.verify, set({ changed: [path], bundleInputs: INPUTS }))
      ).toEqual([path]);
    }
    expect(
      shippedChanges(
        PACKAGES.verify,
        set({ changed: ["packages/verify/src/index.ts"], bundleInputs: INPUTS })
      )
    ).toEqual(["packages/verify/src/"]);
  });

  test("verify: a web file outside the bundle does not count", () => {
    const changed = ["apps/web/lib/stellar/sign.ts", "apps/api/src/config/other.json"];
    expect(shippedChanges(PACKAGES.verify, set({ changed, bundleInputs: INPUTS }))).toEqual([]);
  });

  test("verify: the vectors, tsup config and API report count; tests and scripts do not", () => {
    expect(
      shippedChanges(
        PACKAGES.verify,
        set({
          changed: [
            "packages/verify/vectors/close-v1.json",
            "packages/verify/tsup.config.ts",
            "packages/verify/etc/verify.api.md",
            "packages/verify/tests/pack.test.ts",
            "packages/verify/scripts/generate-vectors.ts",
          ],
          bundleInputs: INPUTS,
        })
      )
    ).toEqual([
      "packages/verify/vectors/",
      "packages/verify/tsup.config.ts",
      "packages/verify/etc/verify.api.md",
    ]);
  });

  test("verify: a consumer-visible package.json field counts, a devDependency does not", () => {
    const manifest = (patch: Record<string, unknown>): string =>
      JSON.stringify({ ...(JSON.parse(VERIFY_MANIFEST) as object), ...patch });
    const changed = ["packages/verify/package.json"];
    const devOnly = manifest({ devDependencies: { tsup: "^9.1.0" } });
    expect(
      shippedChanges(
        PACKAGES.verify,
        set({ changed, manifestBefore: VERIFY_MANIFEST, manifestAfter: devOnly })
      )
    ).toEqual([]);
    const peer = manifest({ peerDependencies: { "@stellar/stellar-sdk": "17.5.0" } });
    expect(
      shippedChanges(
        PACKAGES.verify,
        set({ changed, manifestBefore: VERIFY_MANIFEST, manifestAfter: peer })
      )
    ).toEqual(["packages/verify/package.json peerDependencies"]);
    const files = manifest({ files: ["dist"] });
    expect(
      shippedChanges(
        PACKAGES.verify,
        set({ changed, manifestBefore: VERIFY_MANIFEST, manifestAfter: files })
      )
    ).toEqual(["packages/verify/package.json files"]);
  });
});

describe("changelogVerdict", () => {
  const before = `# Changelog\n\n## [Unreleased]\n\n- Old.\n\n## [0.5.1] - 2026-10-10\n\n- A fix.\n`;

  test("nothing shipped changed passes whatever the changelog says", () => {
    expect(changelogVerdict(PACKAGES.verify, [], before, before)).toEqual({
      errors: [],
      warnings: [],
    });
  });

  test("a shipped change without a new [Unreleased] entry fails", () => {
    const verdict = changelogVerdict(PACKAGES.verify, ["packages/verify/src/"], before, before);
    expectError(verdict, "packages/verify/CHANGELOG.md has no new entry under [Unreleased]");
  });

  test("a shipped change with a new [Unreleased] entry passes", () => {
    const after = before.replace("- Old.", "- Old.\n- New.");
    expect(changelogVerdict(PACKAGES.sdk, ["packages/sdk/src/"], before, after).errors).toEqual([]);
  });

  test("editing an older heading is not an [Unreleased] entry", () => {
    const after = before.replace("- A fix.", "- A fix, reworded.");
    expectError(
      changelogVerdict(PACKAGES.sdk, ["packages/sdk/src/"], before, after),
      "no new entry"
    );
  });

  test("a base without the file or without [Unreleased] counts as empty", () => {
    const after = `# Changelog\n\n## [Unreleased]\n\n- New.\n`;
    const legacy = `# Changelog\n\n## [0.1.0] - Unreleased\n\n- Old.\n`;
    for (const base of [null, legacy]) {
      expect(changelogVerdict(PACKAGES.verify, ["x"], base, after).errors).toEqual([]);
    }
    const empty = `# Changelog\n\n## [Unreleased]\n`;
    expectError(changelogVerdict(PACKAGES.verify, ["x"], null, empty), "no new entry");
  });
});

describe("the verify bundle inputs", () => {
  test("are the files tsup compiles, including the three modules and the registries", async () => {
    const inputs = await bundleInputs(ROOT);
    for (const path of [
      "packages/verify/src/index.ts",
      "apps/web/lib/stellar/verify.ts",
      "apps/web/lib/stellar/exit-expectations.ts",
      "apps/web/lib/stellar/verification-error.ts",
      "apps/api/src/config/exchange-registry.json",
      "apps/api/src/config/contract-registry.json",
      "apps/web/config/xbull-asset-map.json",
    ]) {
      expect(inputs).toContain(path);
    }
    for (const path of inputs) {
      expect(path.startsWith("..")).toBe(false);
      expect(path.includes("node_modules")).toBe(false);
      expect(() => readFileSync(join(ROOT, path))).not.toThrow();
    }
  });
});

describe("the repository agrees with itself", () => {
  const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");
  const version = (dir: string): string =>
    (JSON.parse(read(`${dir}/package.json`)) as { version: string }).version;

  test("the SDK's package.json, SDK_VERSION, CHANGELOG.md and the docs pin agree", () => {
    const versionConstant = /SDK_VERSION = "([^"]+)"/.exec(
      read("packages/sdk/src/version.ts")
    )?.[1];
    const verdict = checkAgreement({
      pkg: PACKAGES.sdk,
      mode: "offline",
      packageVersion: version("packages/sdk"),
      versionConstant: versionConstant ?? "",
      changelog: read("packages/sdk/CHANGELOG.md"),
      docs: [{ path: "docs/sdk/versioning.mdx", text: read("docs/sdk/versioning.mdx") }],
    });
    expect(verdict.errors).toEqual([]);
  });

  test("the verifier's package.json and CHANGELOG.md agree", () => {
    const verdict = checkAgreement({
      pkg: PACKAGES.verify,
      mode: "offline",
      packageVersion: version("packages/verify"),
      changelog: read("packages/verify/CHANGELOG.md"),
      docs: [],
    });
    expect(verdict.errors).toEqual([]);
  });
});

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};

type Job = {
  name?: string;
  if?: string;
  needs?: string[];
  environment?: string;
  "timeout-minutes"?: number;
  permissions: Record<string, string>;
  strategy?: { matrix: { include: { name: string; checks: string }[] } };
  steps: Step[];
};

for (const pkg of [PACKAGES.sdk, PACKAGES.verify]) {
  const file = `publish-${pkg.id}.yml`;
  describe(file, () => {
    const text = readFileSync(join(ROOT, ".github/workflows", file), "utf8");
    const workflow = YAML.parse(text) as {
      on: Record<string, unknown>;
      permissions: unknown;
      concurrency: { group: string; "cancel-in-progress": boolean };
      jobs: Record<string, Job>;
    };
    const jobs = Object.values(workflow.jobs);
    const steps = jobs.flatMap((job) => job.steps);
    const runs = steps.map((s) => s.run ?? "").join("\n");

    test("runs only on its own tag push or by hand", () => {
      expect(Object.keys(workflow.on).sort()).toEqual(["push", "workflow_dispatch"]);
      expect(workflow.on).not.toHaveProperty("pull_request");
      expect(workflow.on).not.toHaveProperty("pull_request_target");
      expect(workflow.on.push).toEqual({ tags: [`${pkg.tagPrefix}*.*.*`] });
    });

    test("grants nothing at the top and only read and id-token to its one job", () => {
      expect(workflow.permissions).toEqual({});
      expect(jobs).toHaveLength(1);
      expect(jobs[0].permissions).toEqual({ contents: "read", "id-token": "write" });
      expect(jobs[0].environment).toBe("npm-publish");
      expect(jobs[0]["timeout-minutes"]).toBeGreaterThan(0);
      expect(text).not.toContain("contents: write");
    });

    test("never cancels a publish in progress, one run per tag", () => {
      expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
      expect(workflow.concurrency.group.startsWith(`publish-${pkg.id}-`)).toBe(true);
    });

    test("no run step interpolates a workflow input", () => {
      for (const step of steps) {
        expect(step.run ?? "").not.toContain("${{ inputs.");
        expect(step.run ?? "").not.toContain("${{ github.event.inputs.");
      }
    });

    test("checks out without persisted credentials", () => {
      const checkout = steps.find((s) => s.uses?.startsWith("actions/checkout@"));
      expect(checkout?.with?.["persist-credentials"]).toBe(false);
    });

    test("validates the tag as exactly its own prefix and X.Y.Z", () => {
      expect(runs).toContain(`^${pkg.tagPrefix}[0-9]+\\.[0-9]+\\.[0-9]+$`);
    });

    test("runs the agreement check, the gates, the pack check and publishes the checked tarball", () => {
      expect(runs).toContain(`scripts/package-release.ts ${pkg.id} publish`);
      for (const gate of ["type-check", "lint", "test", "check-api", "build:dist", "pack:check"]) {
        expect(runs).toContain(`bun run --filter '${pkg.name}' ${gate}`);
      }
      expect(runs).toContain('npm publish "$TARBALL" --provenance --access public');
      expect(runs).not.toMatch(/npm publish\s*(--|$)/m);
      expect(runs).toContain(`npm view ${pkg.name} dist-tags.latest`);
    });
  });
}

describe("ci.yml release jobs", () => {
  const ci = YAML.parse(readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8")) as {
    jobs: Record<string, Job>;
  };
  const runsOf = (job: Job): string => job.steps.map((s) => s.run ?? "").join("\n");

  test("the aggregate gate needs and checks both release jobs", () => {
    const aggregate = ci.jobs.ci;
    expect(aggregate.needs).toContain("changelog");
    expect(aggregate.needs).toContain("release-agreement");
    const script = runsOf(aggregate);
    expect(script).toContain("needs.changelog.result");
    expect(script).toContain("needs.release-agreement.result");
  });

  test("the changelog guard runs for both packages on pull requests", () => {
    const job = ci.jobs.changelog;
    expect(job.if).toBe("github.event_name == 'pull_request'");
    const runs = runsOf(job);
    expect(runs).toContain("bun scripts/package-release.ts sdk changelog");
    expect(runs).toContain("bun scripts/package-release.ts verify changelog");
    for (const step of job.steps.filter((s) => s.run?.includes(" changelog"))) {
      expect(step.env?.BASE_REF).toBe("${{ github.base_ref }}");
      expect(step.run).not.toContain("${{");
    }
  });

  test("the release agreement tests the script and checks both packages", () => {
    const runs = runsOf(ci.jobs["release-agreement"]);
    expect(runs).toContain("bun test ./scripts/package-release.test.ts");
    expect(runs).toContain("bun scripts/package-release.ts sdk pr");
    expect(runs).toContain("bun scripts/package-release.ts verify pr");
  });

  test("the verify row builds, packs and checks the release files", () => {
    const row = ci.jobs.check.strategy!.matrix.include.find((r) => r.name === "verify")!;
    const checks = row.checks.split(" ");
    for (const check of ["test", "check-api", "build:dist", "pack:check", "release:check"]) {
      expect(checks).toContain(check);
    }
    expect(checks.indexOf("check-api")).toBeLessThan(checks.indexOf("build:dist"));
    expect(checks.indexOf("build:dist")).toBeLessThan(checks.indexOf("pack:check"));
  });
});
