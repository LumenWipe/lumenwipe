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

Vercel's own GitHub integration deploys on every push to `main` (production) and every PR (preview).
There is no GitHub Actions workflow for this - Vercel watches the repo directly. `package.json`'s
`version` field is not customer-facing and is not bumped as part of a release.

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
- **The `/v1` route prefix** - this is the real, external contract. A breaking change to the close
  API's request/response shapes gets a new prefix (`/v2`) rather than breaking `/v1` out from under
  existing integrators. `/v1` has not needed to move yet. Endpoints outside `/v1` (`/health`,
  `/:network/account/...`, etc.) are still expected to be additive-only for the same reason, just
  without a prefix to bump if that ever stops being true.

**Rollback**: `gcloud run services update-traffic lumenwipe-api --to-revisions=<previous-revision>=100`
routes traffic back to the last known-good revision without a new deploy. Cloud Run keeps prior
revisions around; nothing needs to be rebuilt.

## SDK: releasing to npm

`packages/sdk` is the only component with a real external dependency graph - someone's
`package.json` names an exact version - so it's the only one with real semver and a real gate.

### The checklist

1. Decide the version bump (semver: breaking / feature / fix).
2. Bump `packages/sdk/package.json`'s `"version"`.
3. Add an entry to `packages/sdk/CHANGELOG.md` (Keep a Changelog format - see the file for the
   pattern) describing what changed, from the consumer's point of view.
4. Open a PR with just those two file changes (`chore(sdk): release vX.Y.Z`). Get it merged to
   `main` like any other PR - CI runs the same `sdk` matrix entry every other PR gets.
5. Once merged, tag the exact commit on `main` and push the tag:
   ```bash
   git checkout main && git pull
   git tag sdk-vX.Y.Z
   git push origin sdk-vX.Y.Z
   ```
6. `.github/workflows/publish-sdk.yml` picks up the tag, re-runs type-check/lint/test/build,
   double-checks the tag's version matches `package.json` (fails loudly if someone tagged the
   wrong commit), and publishes to npm with provenance.
7. Confirm: `npm view @lumenwipe/sdk` shows the new version as `latest`.

If a tagged run fails after the checks pass but before `npm publish` completes (a registry blip,
say), re-run it with `workflow_dispatch` and the same tag - `dist-tag`s are still whatever they
were, nothing is left half-published.

### What forces a version bump

Any change to `packages/sdk/src/**` needs at least a patch bump before it reaches consumers -
nothing publishes it otherwise. Because the SDK's build step
(`tsup` + `api-extractor`, see `packages/sdk/package.json`'s `build` script) rolls up
`@lumenwipe/types` into the SDK's own bundled `.d.ts`, a `packages/types/src/**` change that
alters a type the SDK re-exports needs a bump too, even though `packages/sdk/src/**` itself didn't
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

`.github/workflows/ci.yml`'s `sdk-version-bump` check fails a PR that touches
`packages/sdk/src/**` or `packages/types/src/**` without also changing
`packages/sdk/package.json`'s `version` field. It does **not** publish anything itself - bumping
the version just satisfies the check; the actual publish still needs the tag-push step above. This
catches "forgot entirely," not "bumped the wrong amount" - semver correctness is still a human
judgment call.

### The other direction: the live API outrunning an already-published SDK

The gap above is about the SDK falling behind its own source. There's a second, sharper version
of the same risk: `apps/api` deploys itself on every merge to `main` (see above), while
`packages/sdk` only reaches npm on a maintainer's deliberate tag push. Between those two events,
production can be running API behavior that no published SDK version has ever seen - and if that
behavior is a breaking change to something the SDK already depends on, an integrator installing
`@lumenwipe/sdk` from npm today gets a client built against a contract that no longer matches
what it's calling.

Two things make this concrete rather than theoretical:

- **Most of the API has no version boundary at all.** Only `CloseController` (`close/plan`,
  `close/transactions`, `submit`) is under `/v1`. `account`, `mediator`, `fee-bump`, `health`, and
  `config` have no prefix, so there's no `/v2` to cut if one of them needs a breaking change -
  today, "don't break it" is the only policy those endpoints have. Treat every field currently
  returned or accepted by any live endpoint, versioned or not, as permanent, additive-only surface
  until that changes.
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

## Why `@lumenwipe/types` stays private

It's `"private": true` in `packages/types/package.json` on purpose, not an oversight. The SDK's
build (`api-extractor`) bundles every type it needs directly into its own `dist/index.d.ts`, so an
npm consumer of `@lumenwipe/sdk` never resolves `@lumenwipe/types` as a separate package - there is
nothing for them to depend on. Publishing it would add a second public surface with its own
compatibility promises for zero actual benefit to anyone outside this repo.

## Tag and environment protection

`sdk-v*` tags are not currently protected - anyone with push access can push one from any branch
and trigger a real npm publish, and the `npm-publish` GitHub environment has no required reviewers
or branch restriction. For a two-person team this hasn't bitten anyone, but it's worth tightening
before onboarding another maintainer:

- A [tag protection rule](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-tag-protection-rules)
  for `sdk-v*` restricting who can create matching tags.
- A `deployment_branch_policy` on the `npm-publish` environment restricting it to `main`, so a tag
  pushed against a stray branch can't publish even if someone creates one by mistake.

Neither is done yet; both are additive settings changes, not code.
