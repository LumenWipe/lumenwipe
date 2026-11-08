# Releasing

LumenWipe ships three independently-versioned components, each with a different release model
because each has a different kind of consumer:

| Component      | Consumer                                                      | Model                                                           |
| -------------- | ------------------------------------------------------------- | --------------------------------------------------------------- |
| `apps/web`     | End users, via lumenwipe.com                                  | Continuous deploy, no version number                            |
| `apps/api`     | The web app, and third-party integrators calling it over HTTP | Continuous deploy, versioned by URL prefix, not by build number |
| `packages/sdk` | Third-party integrators, via npm                              | **Real semver, gated behind a git tag**                         |

`packages/types` is `"private": true` and never published - see [Why `@lumenwipe/types` stays
private](#why-lumenwipetypes-stays-private) below for why that's not a gap.

The one rule that matters most: **only the SDK has a publish step a human must remember to
trigger.** Web and the API deploy themselves. If you take one thing from this doc, take the
[SDK release checklist](#sdk-releasing-to-npm).

## `apps/web`

Vercel's own GitHub integration deploys on every push to `main` (production). There is no GitHub
Actions workflow for this - Vercel watches the repo directly. `package.json`'s `version` field is
not customer-facing and is not bumped as part of a release.

Other branches get no deployment: `git.deploymentEnabled` in each app's `vercel.json` allows only
`main` and `preview/**`. To see a change on a preview URL, push it to a branch named
`preview/<description>`. On any other branch a PR's checks are CI only.

Each app's `vercel.json` also runs `scripts/vercel-ignore.mjs`, which skips a build when nothing the
app depends on changed since the last deployed commit (its path lists live in that script). It
builds whenever the comparison cannot be made. A dashboard redeploy always builds. A build skipped
this way still counts as a deployment, which is why branch filtering lives in `deploymentEnabled`.

**Rollback**: promote a previous deployment from the Vercel dashboard. No git revert or redeploy
needed for an emergency rollback - it's already built.

## `apps/api`

`.github/workflows/deploy-api.yml` deploys a new Cloud Run revision on every push to `main` that
touches `apps/api/**`, `packages/**`, or root workspace config. Like web, this is continuous: there
is no version-triggered gate, and a merge to `main` is a deploy.

Two different "versions" exist for the API and they answer different questions:

- **`API_VERSION`** (`apps/api/src/openapi.ts`) - a human-readable marker shown in the OpenAPI
  spec and at `/`. It is **not** read from `package.json` (see the comment in that file for why:
  a `rootDir` boundary issue with the build) and it is **not** a deploy gate - bump it by hand when
  a change is worth calling out in the spec, roughly semver-flavored (minor for a new capability,
  patch for a fix), but nothing enforces this today and a missed bump breaks nothing.
- **The `/v1` route prefix** - this is the real, external contract. Every integrator route lives
  under `/v1`, and a breaking change to a request or response shape gets a new prefix (`/v2`)
  rather than breaking `/v1` out from under existing integrators. `/v1` has not needed to move yet.
  Only the operational routes (`/`, `/health`, `/health/deep`, `/health/dependencies`) and the
  operator-only `/admin/api-keys` routes stay unversioned; the admin routes are excluded from the
  public spec and are not a contract with integrators. The pre-`/v1` paths (`/:network/account/...`,
  `/:network/mediator/...`, `/config/exchange-registry`, `/integrator/...`, and so on) are aliases
  rewritten to their `/v1` route in `apps/api/src/common/legacy-aliases.ts`, and answer with
  `Deprecation`, `Sunset: Tue, 01 Jun 2027 00:00:00 GMT` and a `successor-version` `Link`. They
  stay until a release after the sunset date removes them; access log lines for them carry
  `deprecatedAlias: true`, which is how to check nobody still depends on them first.

**Rollback**: `gcloud run services update-traffic lumenwipe-api --to-revisions=<previous-revision>=100`
routes traffic back to the last known-good revision without a new deploy. Cloud Run keeps prior
revisions around; nothing needs to be rebuilt.

## SDK: releasing to npm

`packages/sdk` is the only component with a real external dependency graph - someone's
`package.json` names an exact version - so it's the only one with real semver and a real gate.

### Between releases

A PR that changes what the SDK does never touches its version. It adds a line under
`## [Unreleased]` in `packages/sdk/CHANGELOG.md` (Keep a Changelog: `Added`, `Changed`, `Fixed`,
`Removed`), written from the consumer's point of view. That keeps `package.json` equal to the
latest version on npm once each release is published, and the bump is decided once per release by
reading the whole section.

The changelog keeps two pieces of history that must not be "fixed" with tags. `0.4.0`, `0.4.1`,
`0.4.2`, `0.5.0` and `0.6.0` were cut in the repository but never published; each heading says
`Not published to npm; first available in 0.5.1.` (or `0.7.0`). `0.3.x` was never released at
all. None of them has an `sdk-v*` tag and none gets one: a tag publishes, so a historical tag would
publish code that was never released. Only published versions get a compare link at the bottom of
the changelog.

### The checklist

1. Read `## [Unreleased]` and decide the bump (semver: breaking / feature / fix; before 1.0, a
   breaking change is a minor bump).
2. Set `packages/sdk/package.json`'s `"version"` and `SDK_VERSION` in `packages/sdk/src/version.ts`.
3. Rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD` and open a new, empty `## [Unreleased]`
   above it. At the bottom of the changelog, point `[Unreleased]` at
   `compare/sdk-vX.Y.Z...HEAD` and add `[X.Y.Z]: .../compare/sdk-v<previous>...sdk-vX.Y.Z`.
4. Set the pin in `docs/sdk/versioning.mdx` to `~X.Y.0`.
5. Open a PR with just those file changes (`chore(sdk): release vX.Y.Z`). Get it merged to
   `main` like any other PR. Besides the `sdk` matrix entry every PR gets, the
   `sdk release agreement` job checks that steps 2 to 4 agree, that `X.Y.Z` is above the base
   branch's version and npm `latest`, and that neither npm nor the tags have it yet.
6. Once merged, tag the exact commit on `main` and push the tag:
   ```bash
   git checkout main && git pull
   git tag sdk-vX.Y.Z
   git push origin sdk-vX.Y.Z
   ```
7. `.github/workflows/publish-sdk.yml` picks up the tag. It checks the tag is exactly
   `sdk-vX.Y.Z`, that its commit is on `main` and agrees with `package.json`, `SDK_VERSION`,
   the changelog and the docs pin (`bun scripts/sdk-release.ts publish`), and that npm does not
   have the version yet. It re-runs type-check, lint, test, `check-api` and the build, runs
   `pack:check`, publishes the tarball `pack:check` checked with provenance, and stays red until
   npm `latest` is the new version. It creates no GitHub release and needs no write access to the
   repository.
8. Optionally, publish a GitHub release for the tag with the changelog section as its notes:
   `bun scripts/sdk-release.ts notes X.Y.Z` prints it.

Between steps 5 and 7 the version is merged but not on npm. Every check reports that as a warning,
never a failure, so other PRs are not blocked while a release waits for its tag.

If a tagged run fails before `npm publish` completes (a registry blip, say), re-run it with
`workflow_dispatch` and the same tag; `dist-tag`s are still whatever they were. Once the version
is on npm a re-run fails the agreement check on purpose: npm never accepts the same version twice,
so a fix ships as the next patch release.

### What needs a changelog entry

Any change to `packages/sdk/src/**` reaches consumers on the next release, so it needs an
`[Unreleased]` entry. Because the SDK's build step
(`tsup` + `api-extractor`, see `packages/sdk/package.json`'s `build` script) rolls up
`@lumenwipe/types` into the SDK's own bundled `.d.ts`, a `packages/types/src/**` change that
alters a type the SDK re-exports needs one too, even though `packages/sdk/src/**` itself didn't
change.

### The gap this replaces

Before this doc, nothing said _when_ to cut a release - a PR could land in `packages/sdk/src/`
(or in `packages/types/src/` underneath it) with no reminder that npm now has a stale version.
`apps/web` and `apps/playground` never notice, because they resolve `@lumenwipe/sdk` from
**source** via tsconfig `paths` + Next's `transpilePackages` (see CLAUDE.md's SDK-from-source
gotcha) - they always run the latest code regardless of what's on npm. The only party who's ever
behind is a **third-party integrator** installing from npm. That's a real gap, just a quiet one:
nothing breaks internally, so nothing forces the conversation.

CI now catches the specific case that matters (see below); everything else is judgment at review
time - a PR reviewer touching `packages/sdk/src/` should ask "does this need a release" the same
way they'd ask about a migration or a breaking change.

### CI guardrail

`.github/workflows/ci.yml`'s `sdk-changelog` check fails a PR that touches `packages/sdk/src/**`,
or changes the content of `packages/sdk/etc/sdk.api.md`, without changing the
`## [Unreleased]` section of `packages/sdk/CHANGELOG.md`. It publishes nothing and says nothing
about when to release; that stays a maintainer's call.

Three more checks keep the release itself consistent:

- `release:check` in the `sdk` matrix entry (`bun scripts/sdk-release.ts offline`) fails when
  `package.json`'s version has no matching newest `CHANGELOG.md` heading, when `SDK_VERSION`
  differs, when headings are duplicated, out of order or malformed, when a compare link is wrong or
  belongs to an unpublished version, and when the docs pin is not `~X.Y.0` for the current version.
- The `sdk release agreement` job (`bun scripts/sdk-release.ts pr`) adds npm and the `sdk-v*` tags:
  every npm version needs its tag and an unmarked heading, every tag a heading, npm `latest` must
  not be ahead of `package.json`, and a release PR's version must be new to npm and to the tags and
  above both npm `latest` and the base branch. A merged version not on npm yet is a warning.
- `pack:check` in the `sdk` matrix entry packs the SDK and checks the tarball: exactly `LICENSE`,
  `CHANGELOG.md`, `README.md`, `package.json` and the four `dist` files; `publint` and
  `@arethetypeswrong/cli`; an offline install into an empty project on the minimum supported Node,
  where `import` and `require` expose the same exports and a working client; and a type-check of
  both entry points with the current TypeScript and with the minimum one the README names (pinned
  as the `typescript-minimum` devDependency). `packages/sdk/LICENSE` is a copy of the root
  `LICENSE`, and a test fails if they differ.

### The other direction: the live API outrunning an already-published SDK

The gap above is about the SDK falling behind its own source. There's a second, sharper version
of the same risk: `apps/api` deploys itself on every merge to `main` (see above), while
`packages/sdk` only reaches npm on a maintainer's deliberate tag push. Between those two events,
production can be running API behavior that no published SDK version has ever seen - and if that
behavior is a breaking change to something the SDK already depends on, an integrator installing
`@lumenwipe/sdk` from npm today gets a client built against a contract that no longer matches
what it's calling.

Two things make this concrete rather than theoretical:

- **A version prefix only helps once a `/v2` exists.** Every integrator route is under `/v1` (see
  [`apps/api`](#appsapi) above), but nothing serves a `/v2` yet, so today "don't break it" is the
  policy for every endpoint. Treat every field currently returned or accepted by any live endpoint,
  versioned or not, as permanent, additive-only surface until that changes.
- **The SDK's own build now has a structural tripwire for this.** `packages/sdk/api-extractor.json`
  enables `apiReport`, which snapshots the SDK's full flattened public type surface - including
  every field pulled in from `@lumenwipe/types`, however deeply nested - into
  `packages/sdk/etc/sdk.api.md`. `bun run --filter '@lumenwipe/sdk' check-api` (part of the `sdk`
  CI matrix entry) fails if the current build's surface doesn't match that file. A field
  added, removed, or retyped on `AccountState`, `DefiPosition`, or anything else the SDK's methods
  touch - the exact shape a live API change would take - shows up as a required diff to
  `sdk.api.md` in the PR, not as a silent surface change nobody reviewed. (`bun run build`'s
  `api-extractor run --local` auto-updates the file for a legitimate change; `check-api` runs the
  same tool without `--local`, so CI fails instead of quietly rewriting it.)

Together these don't stop a breaking API change from shipping - nothing can, short of never
deploying continuously - but they force it to leave a paper trail: an `sdk.api.md` diff for
anything the SDK actually depends on, and, for `/v1`, a version bump instead of an in-place
change. What they don't cover is `apps/api` behavior the SDK's own types don't model (an
undocumented status code, a header, a timing change) - that class of drift is still a human
judgment call at review time, the same way "does this need a release" is above.

## `@lumenwipe/verify`: the reference verifier

`packages/verify` is not published yet: there is no publish workflow or `verify-v*` tag for it, and
its `CHANGELOG.md` holds `0.1.0` as unreleased. Until there is, `0.1.0` stays the version and the
rules below apply to its first release and every one after.

It has no source of its own. tsup compiles the web's `apps/web/lib/stellar/verify.ts`,
`exit-expectations.ts` and `verification-error.ts` with everything they import, including the
registries (`apps/api/src/config/exchange-registry.json`, `contract-registry.json` and
`apps/web/config/xbull-asset-map.json`). So a release is due whenever any of that changes, even
when nothing under `packages/verify` did:

- **every registry change** - an exchange added or re-verified, a new `validUntil`, a contract
  added or re-pinned. Integrators run on the bundled registry only, never the served one, so an
  exchange listed after their release is checked as a plain wallet, and once the bundled
  `validUntil` passes every exchange close is refused. A registry change without a verify release
  leaves them exactly there;
- every change to what `verify()` accepts or how it words a refusal, which also changes
  `vectors/close-v1.json` (the web's `verify-conformance.test.ts` fails until the vectors are
  regenerated with `bun run --filter '@lumenwipe/verify' vectors`);
- every change to the package's public types (`packages/verify/etc/verify.api.md`).

The bump follows the SDK's semver rules above. A registry-only release is a patch; a newly
refused shape is a minor before 1.0. Add the change under `## [Unreleased]` in
`packages/verify/CHANGELOG.md` in the PR that makes it, and name the registry version it bundles.

## Why `@lumenwipe/types` stays private

It's `"private": true` in `packages/types/package.json` on purpose, not an oversight. The SDK's
build (`api-extractor`) bundles every type it needs directly into its own `dist/index.d.ts`, so an
npm consumer of `@lumenwipe/sdk` never resolves `@lumenwipe/types` as a separate package - there is
nothing for them to depend on. Publishing it would add a second public surface with its own
compatibility promises for zero actual benefit to anyone outside this repo.

## Tag and environment protection

`sdk-v*` tags are not currently protected - anyone with push access can push one. The publish
workflow refuses a tag whose commit is not on `main`, so a tag on a stray branch fails before
anything is built, but a tag on any commit of `main` still publishes, and the `npm-publish` GitHub
environment has no required reviewers. For a two-person team this hasn't bitten anyone, but it's
worth tightening before onboarding another maintainer:

- A [tag protection rule](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-tag-protection-rules)
  for `sdk-v*` restricting who can create matching tags.
- A `deployment_branch_policy` on the `npm-publish` environment restricting it to `main`, so a tag
  pushed against a stray branch can't publish even if someone creates one by mistake.

Neither is done yet; both are additive settings changes, not code.
