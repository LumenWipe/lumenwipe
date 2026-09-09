---
title: "Security tooling remediation plan"
sidebarTitle: "Remediation plan"
description: "Results of the dependency audit, static analysis, and secret scan run for the Phase 2 security hardening pass, with a resolution or accepted-risk rationale for every finding."
icon: "clipboard-check"
---

> This document is the third and final security commitment of epic #166, alongside the adversarial
> test suite (running in CI since #191) and the [STRIDE threat model](/threat-model) (#170). It
> records what three security tools found against the codebase on **2026-09-02** and, per the
> commitment, gives every critical, high, and medium finding a resolution or an explicit
> accepted-risk rationale - never a silent backlog entry.

## 1. Scope and method

Three tool categories, run against `chore/security-tooling-remediation-171` (branched from
`feature/phase-2` at commit `28287a6`):

1. **Dependency audit** - `bun audit` (Bun 1.3.11's native advisory scanner) across the full
   workspace lockfile.
2. **Static analysis** - `semgrep` 1.175.0, rule packs `p/security-audit`, `p/typescript`,
   `p/javascript`, `p/secrets`, against `apps/` and `packages/` (excluding `node_modules`, `.next`,
   `dist`).
3. **Secret scanning** - `gitleaks` 8.30.1 against the **full git history** (352 commits), not just
   the working tree, since a since-rotated secret in an old commit is still an exposure.

Every finding below was triaged by actual reachability, not by severity label alone: for each
flagged package, its dependency path was traced (`bun pm why`), and where the code could plausibly
ship to a browser, the production bundle was inspected directly for its presence. This mirrors the
method the [threat model](/threat-model) uses for its own residual-risk table (Section 7) - a
mitigation or an acceptance is only as good as the evidence behind it.

Out of scope: a third-party penetration test or formal audit, deferred by epic #166 itself.

## 2. Dependency audit

`bun audit` started at **78 advisories across 25 packages** (1 critical, 36 high, 34 moderate, 7
low). Three rounds of remediation:

| Stage                                                   | Advisories | Packages | Critical | High | Moderate | Low |
| ------------------------------------------------------- | ---------- | -------- | -------- | ---- | -------- | --- |
| Initial                                                 | 78         | 25       | 1        | 36   | 34       | 7   |
| After `bun update` (every workspace, semver-respecting) | 58         | 23       | 0        | 28   | 23       | 7   |
| After targeted `overrides` (below)                      | 39         | 17       | 0        | 22   | 11       | 6   |

**Fixed.** `bun update`, run per workspace (the root-level command alone does not descend into
nested workspaces), absorbed already-compatible patched versions with no `package.json` change:
this alone cleared the critical finding (`protobufjs`, see below) and every `next.js` advisory
(`^15.5.19` → resolved `15.5.25`, past the `15.5.21` fix line). A further round added five targeted
entries to the root `overrides` map (the same mechanism already pinning `@stellar/stellar-sdk` and
`postcss`), because these packages are pulled in by dependencies that pin them exactly rather than
by range:

| Package       | Was           | Now       | Why an override was needed                                                                  |
| ------------- | ------------- | --------- | ------------------------------------------------------------------------------------------- |
| `axios`       | 1.16.0/1.16.1 | `^1.20.0` | Pinned exactly by `@stellar/stellar-sdk@16.0.1` (itself deliberately pinned, see CLAUDE.md) |
| `form-data`   | 4.0.5         | `^4.0.6`  | Transitive via the same `axios` chain                                                       |
| `body-parser` | 1.20.4        | `^1.20.6` | Pinned exactly by `@nestjs/platform-express`                                                |
| `lodash`      | 4.17.21       | `^4.18.1` | Pinned exactly by `@nestjs/config` and `@nestjs/swagger`                                    |
| `postcss`     | `^8.5.15`     | `^8.5.26` | The existing override's floor predated the two 2026 CVEs; widened past both fix lines       |

Verified safe: `bun run type-check && bun run lint && bun run test` all pass across the full
workspace after every change (1,181 tests, 0 failures), and `bun run format:check` is clean (the
`prettier` devDependency bump pulled in by the same `bun update` reflowed six files' comments -
purely cosmetic, no logic changed, included in this PR).

**Accepted risk, with evidence.** Every remaining package was traced to its actual reachability,
not assumed safe by severity:

| Package (severity)                                                                                             | Reachability finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `protobufjs` (was critical) and `elliptic` (low)                                                               | Trace entirely through `@jsr/creit-tech__stellar-wallets-kit` → `@trezor/connect-plugin-stellar` / `@hot-wallet/sdk` (NEAR wallet selector) - optional wallet-kit modules. `apps/web/lib/wallet-kit/modules.ts` imports only five vetted modules directly (Freighter, xBull, Albedo, Rabet, Hana), never Trezor or the NEAR/HOT chain. Verified empirically: built the production web app (`bun run build:web`) and grepped `apps/web/.next/static/chunks/` for "trezor", "protobuf", "near-api-js", "hot-wallet" - zero matches, while a "freighter" sanity-check grep on the same chunks _does_ match, proving the method detects code that's actually bundled. `protobufjs` cleared entirely via `bun update` (a `stellar-wallets-kit` 2.5.0→2.6.0 bump); `elliptic` remains present but unreachable in the shipped bundle. |
| `uuid` (moderate)                                                                                              | The vulnerable `8.3.2` instance comes via `jayson` → `@solana/web3.js` → `@hot-wallet/sdk` - the same unreachable optional wallet-connector chain above. Confirmed absent from the built bundle by the same grep method (the one "solana" match in the bundle is WalletConnect's own chain-namespace metadata strings for its generic multi-chain UI, not `@solana/web3.js` code - inspected directly). The _other_ resolved `uuid` instance, `11.1.1`, is our own direct dependency and is already patched.                                                                                                                                                                                                                                                                                                                   |
| `js-yaml` (high/moderate)                                                                                      | Traces through `@nestjs/swagger` (builds the OpenAPI doc from static decorators at API startup - never parses untrusted YAML) and `gray-matter` (`apps/web/lib/blog.ts` - parses only repo-authored blog frontmatter, never user input). The vulnerable operation (parsing attacker-controlled YAML) is never reachable through either path. Note: per the advisory itself, the high-severity CVE-2026-59870 fix was not backported even to the latest 3.x/4.x releases, so this would remain flagged regardless of version - reachability is the only lever here.                                                                                                                                                                                                                                                             |
| `multer` (high/moderate)                                                                                       | Pinned exactly by `@nestjs/platform-express`. Grepped `apps/api/src` - no route uses `multer` or `FileInterceptor`; this API has no multipart-upload endpoint, so the DoS vectors (all upload-triggered) have nothing to reach.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `file-type` (moderate)                                                                                         | Pinned exactly by `@nestjs/common` (internal MIME-sniffing utility). Same reasoning as `multer` - no upload endpoint exists to hand it attacker-controlled bytes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `sharp` (high)                                                                                                 | Optional peer dependency of `next.js`, used only by the Image Optimization API. Grepped `apps/web` - `next/image` is never imported anywhere in the app; the feature that would invoke `sharp` on external image bytes is unused.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `ajv` (moderate)                                                                                               | Four resolved instances; only `8.12.0` falls in the vulnerable range (`>=7.0.0-alpha.0 <8.18.0`), and it traces through `@angular-devkit/core` → Nest's own schematics/CLI codegen tooling - a `nest generate` dev command, never invoked in CI or production.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `qs` (moderate)                                                                                                | Both resolved instances trace through `@stryker-mutator/core`, a devDependency for mutation testing, never part of any served runtime.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `@nestjs/core` (moderate)                                                                                      | Genuine runtime dependency. The fix is not available within the installed major version (10.x) - `10.4.22` is already the latest 10.x release, and the advisory covers "<=11.1.17". Upgrading to Nest 11/12 is a deliberate framework migration, out of this PR's scope for the same reason `@stellar/stellar-sdk` major bumps are gated (CLAUDE.md, `renovate.json`) - not something to fold into a dependency-audit pass. **Tracked as a follow-up** (Section 6).                                                                                                                                                                                                                                                                                                                                                            |
| `brace-expansion`, `browserslist`, `esbuild`, `glob`, `picomatch`, `postcss-selector-parser`, `tmp`, `webpack` | All trace to build/dev tooling only - `@nestjs/cli`, `@typescript-eslint/*`, `autoprefixer`/`tailwindcss`, `tsup`, Angular schematics (confirmed individually via `bun pm why` for each). None run against any input the tool serves to a user; none ship to a served runtime.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

**Ongoing cadence.** `renovate.json` already runs a weekly dependency scan with an "at any time"
bypass for vulnerability alerts (`vulnerabilityAlerts.schedule: ["at any time"]`), so this isn't a
one-off - future advisories on these same packages get picked up automatically. This document
records a point-in-time baseline the ongoing cadence builds on, not a substitute for it.

## 3. Static analysis

`semgrep` with `p/security-audit`, `p/typescript`, `p/javascript`, `p/secrets` (127 rules, 311
files) found **one finding**, fixed in this PR:

**`javascript.node-crypto.security.gcm-no-tag-length`** in `apps/playground/lib/crypto.ts:38`
(now line 44) - `createDecipheriv("aes-256-gcm", ...)` was called without an explicit
`authTagLength`, which the rule flags on principle: an implicit tag length can, in some
configurations, allow a truncated-tag forgery. In this specific case Node's implicit default for
GCM is already 16 bytes (the correct, secure value) and `setAuthTag` already rejects any tag that
isn't exactly that length, so this was not an active vulnerability - but making it explicit
removes any ambiguity for a future refactor and closes the finding outright. Fixed by passing
`{ authTagLength: 16 }` to both `createCipheriv` and `createDecipheriv` in
`apps/playground/lib/crypto.ts`; the existing round-trip test suite
(`apps/playground/tests/unit/crypto.test.ts`) still passes unchanged. Re-run after the fix: **0
findings**.

No security-specific ESLint rules exist in this repo today (`.eslintrc.json` files use only
`eslint:recommended` + `@typescript-eslint/recommended`), so this scan is new signal rather than
overlap with CI's existing `lint` job - worth re-running on a similar cadence going forward
(Section 6).

## 4. Secret scanning

`gitleaks` against the full 352-commit history found **32 raw hits, collapsing to a handful of
distinct values** after triage:

**Finding, fixed - traced to its source.** A syntactically valid Stellar secret key
(`SCZANGBA5YHTNYVVV4C3U252E2B6P6F5T3U6MM63WBSBZATAQI3EBTQ4`) was committed as test-fixture
plaintext in `apps/playground/tests/unit/crypto.test.ts` (and an earlier path,
`tests/unit/playground-crypto.test.ts`). It derives to
`GC2BKLYOOYPDEFJKLKY6FNNRQMGFLVHJKQRGNSSRRGSMPGF32LHCQVGF`, which - verified via a read-only
Horizon query, no on-chain action taken - holds real balances on both mainnet (~16.13 XLM plus a
second asset) and testnet (~10,088 XLM plus two assets), with a pattern of recurring inbound
payments through mid-2026.

Traced the source before treating this as an incident: this is not a private key of unknown
origin. GitHub code search puts the exact same secret key in **142 files across at least 11 public
repositories**, including `stellar/stellar-docs` itself - it is the "AstroDollar" issuer account
hardcoded into the official ["How to Issue an
Asset"](https://developers.stellar.org/docs/tokens/how-to-issue-an-asset) tutorial's full code
sample (JS, Python, and Java versions alike), copied from there into SDK examples and demo projects
across the ecosystem (Soneso's multi-language SDKs, a Kuknos fork, a Kinesis SDK fork, and several
independent tutorial-following projects). It was never a secret - it is deliberately public,
widely-republished documentation material, which is almost certainly why it accumulated real
balances on both networks over time (people running the tutorial, not a personal wallet being
compromised).

That provenance changes the framing but not the fix: using a real, checksum-valid keypair - even a
publicly-known one - as test fixture data was still the wrong move, for the same reason
CLAUDE.md's new convention (below) states plainly - a secret scanner can't tell "famous public
example key" from "leaked production secret" from the string alone, and neither should a reviewer
have to. The test never needed a valid Stellar key at all - `encryptSecret`/`decryptSecret`
round-trip arbitrary strings - so the fixture is now a plaintext string that is deliberately **not**
a valid strkey (`playground-crypto-test-fixture-not-a-real-secret-000000`), removing any future
ambiguity. This fixes the fixture going forward; the key remains visible in the specific historical
commits that introduced and later moved it in this repository's own history. Given it's a
publicly-known documentation example rather than a private exposure, a git history rewrite to strip
it isn't warranted on security grounds - those historical fingerprints are recorded, not hidden, in
`.gitleaksignore` (with a comment explaining exactly why), so a future scan stays actionable for
genuinely new findings instead of re-surfacing this one every time.

**False positives, reviewed and allowlisted** (`.gitleaks.toml`):

- Six high-entropy `"C..."` strings in `apps/api/tests/unit/fixtures/octopos/empty-portfolio.json`
  (`tokenShareAddress`, `token0`, `token1`, `tokenA`, `tokenB`, `shareToken`) are Soroban
  contract/asset addresses - public identifiers by construction, not secrets - inside an entirely
  synthetic OctoPos DeFi-position fixture. Allowlisted by path.
- `polar=key_xyz` in a doc comment (`apps/api/src/auth/api-key.service.ts`) and its matching test
  is a worked example of the `API_KEYS=label=key` env-var format, not a real credential.
  Allowlisted by pattern.

Final state: `gitleaks detect --config .gitleaks.toml` reports **no leaks found**.

**Separately, and independent of any code fix in this PR**: this public repository had GitHub's
native secret scanning, secret scanning push protection, and Dependabot security updates all
disabled when this run started. All three are now **enabled** (confirmed via
`gh api repos/LumenWipe/lumenwipe` - `security_and_analysis.secret_scanning.status: "enabled"`,
`secret_scanning_push_protection.status: "enabled"`, `dependabot_security_updates.status:
"enabled"`), giving this point-in-time scan a continuous counterpart going forward.

## 5. Cross-reference against the STRIDE threat model

Per the epic's instruction, every accepted risk above was checked against the four surfaces
[the threat model](/threat-model) already identifies as sensitive: client-side key handling, the
client-side session layer, API transaction construction, and the two backend signing keys
(mediator co-sign, fee-bump sponsor). None of this run's findings touch those surfaces:

- The wallet-connector chain (`protobufjs`/`elliptic`/`uuid`) is adjacent to - but outside -
  Surface 1 (key handling): it's optional wallet-kit modules never imported, not the signing path
  itself.
- `js-yaml`, `multer`, `file-type`, `sharp`, `ajv`, `qs`, and the build-tooling group sit entirely
  outside API transaction construction and the session layer.
- The leaked test key belongs to `apps/playground`, a deliberately separate, isolated demo app
  (CLAUDE.md: "never imports \[production's] closing modules") - it is not one of the two
  production backend signing keys the threat model covers.

No update to `docs/threat-model.md` §7's residual-risk table was needed as a result of this run.

## 6. Follow-up

What this run changed beyond code, and what's still open:

1. **GitHub-native secret scanning, push protection, and Dependabot security updates are now
   enabled** on this repository (Section 4) - confirmed and applied as part of this run, giving this
   point-in-time scan a continuous counterpart going forward.
2. **`@nestjs/core` moderate injection advisory** (Section 2) has no fix within the installed 10.x
   line; resolving it means a deliberate Nest 11/12 migration, tracked as its own issue rather than
   folded into a dependency-audit PR.
3. **Re-run `semgrep` on a recurring cadence** (e.g., wired into CI or run manually each release) -
   this pass found real signal (Section 3) that CI's existing lint job doesn't cover, and cadence is
   part of the epic's stated target state for security tooling.
4. **Test fixtures never use a real, checksum-valid secret key** - even a publicly-known one, per
   the finding in Section 4 - is now a standing convention in `CLAUDE.md`, so this class of finding
   doesn't recur.
