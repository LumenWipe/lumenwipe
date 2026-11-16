---
title: "The verify package"
sidebarTitle: "Verify package"
description: "Decision record for @lumenwipe/verify: how the verifier became a published package, who consumes it, and the questions still open."
icon: "box"
---

> **Status: decided and shipped.** `@lumenwipe/verify` is published (0.4.0 on 2026-11-10). This
> record replaces the design document that was planned before the package existed. It records the
> design that shipped, where it differs from the original proposal, and what is still undecided.
> The release mechanics live in [RELEASING.md](https://github.com/LumenWipe/lumenwipe/blob/main/RELEASING.md#lumenwipeverify-the-reference-verifier)
> and the usage in the [package README](https://github.com/LumenWipe/lumenwipe/blob/main/packages/verify/README.md),
> and they are not repeated here.

## The problem

`verify()` is the trust anchor: the browser signs nothing it has not checked against the user's
own inputs ([architecture](/architecture), Section 7). It lived inside the web app, and the
playground and the SDK example each carried their own copy. Three copies could drift apart, and
none of them could be versioned or reviewed as one unit by an integrator.

## The decision

**One implementation, compiled into a package rather than moved into one.** The verifier's source
stays in the web app: `apps/web/lib/stellar/verify.ts`, `exit-expectations.ts`,
`verification-error.ts` and `verify-revoke-allowance.ts`. `packages/verify` has no verification
logic of its own. `src/index.ts` is a typed facade that tsup compiles from those modules through
relative imports, with the exchange registry, the contract registry and the xBull asset table
bundled in. The original proposal was to extract the code into the package and have the web
import it. Compiling from the web instead keeps the trust anchor where the web's tests, the
[security scope](/security-scope) (the client-side trust anchor row) and the boundary lint rules
already point. It also means a change to the
verifier is a change to the web, reviewed once.

**Public API.** It is held by API Extractor in `packages/verify/etc/verify.api.md`, which CI checks
on every pull request:

- `verifyCloseTransaction(input: VerifyCloseInput)`. The expectation input is
  `CloseExpectationInput`, which extends `ExitExpectations`.
- `exitExpectations(accountState, network)`, which derives the DeFi part of the expectation from
  the account read and the bundled contract registry.
- `requiresMediator(address, network)`.
- `verifyRevokeAllowanceTransaction(...)`.
- `VerificationError` and `RevokeAllowanceVerificationError`, each with a stable error code.

**Peer dependency.** `@stellar/stellar-sdk` is a peer and is never bundled. It is pinned to the
exact version the web verifier is tested with (`packages/verify/package.json`
`peerDependencies`).

**Versioning.** The package has its own semver line, released from `verify-vX.Y.Z` tags by
`.github/workflows/publish-verify.yml`. It is not versioned alongside the SDK. The SDK does not
depend on it at runtime (see below), so a lockstep version would force releases of one package
for changes in the other. `scripts/package-release.ts verify changelog` fails a pull request that
changes any bundle input, the registries included, without an `[Unreleased]` changelog entry.

**Conformance.** `packages/verify/vectors/close-v1.json` runs against the built bundle in both
module formats (`packages/verify/tests/conformance.test.ts`) and against the web source
(`apps/web/tests/unit/verify-conformance.test.ts`); `revoke-allowance-v1.json` does the same
through `revoke-conformance.test.ts` and `verify-revoke-allowance-conformance.test.ts`. The
package and the web cannot disagree without a CI failure.

## Consumers

| Consumer     | How it verifies                                                                                                                     | Evidence                                                                                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web app      | The source itself, before every signature                                                                                           | `apps/web/lib/stellar/verify.ts`                                                                                                                          |
| Playground   | The workspace build of `@lumenwipe/verify`, held to the session record by playground-only rules that come on top of the shared ones | `apps/playground/lib/verify.ts` and `lib/allowances.ts` import `@lumenwipe/verify`; `apps/playground/eslint.config.mjs` forbids importing from `apps/web` |
| SDK          | No verifier of its own: `runClose` takes a `verify` hook and calls it before every signature                                        | `packages/sdk/src/close-engine.ts` (`verify`); `@lumenwipe/verify` is only a dev dependency in `packages/sdk/package.json`                                |
| SDK examples | `@lumenwipe/verify`, passed as the `verify` hook                                                                                    | `packages/sdk/examples/verify.ts` and `exchange-close.ts`; run nightly by `.github/workflows/sdk-example-nightly.yml`                                     |
| Integrators  | The published package                                                                                                               | [SDK verification guide](/sdk/verification)                                                                                                               |

The three copies the original proposal had to keep in lockstep no longer exist. The playground
and the SDK example both import the package, so no migration order is needed.

## Open questions

1. **Should the source move into the package?** The web owns the code today and the package is
   compiled from it. Moving the code into `packages/verify` and having the web import the package
   would make the package self-contained. It would also move the trust anchor out of the path the
   security review and the boundary lint rules currently scope. Nothing has forced the move yet.
2. **How does an integrator learn that their bundled registry is about to expire?** The package
   README says a new version is released on every registry change, and an installed copy refuses
   closes to a listed exchange once its bundled `validUntil` passes. The registry expiry runbook
   (`docs/runbooks/registry-expiry.mdx`) restamps the registries but does not mention cutting a
   verify release. Nothing tells an integrator ahead of time that the copy they run is close to
   expiry.
3. **Exact or ranged Stellar SDK peer?** The exact pin means every Renovate bump of
   `@stellar/stellar-sdk` needs a verify release, and every integrator has to install that exact
   version (RELEASING.md). A range would spare both, at the cost of running against a Stellar SDK
   version the conformance vectors were never run with.
4. **What makes it 1.0?** RELEASING.md defines the bump rules before 1.0 (a newly refused shape
   is a minor) but no criteria for 1.0 itself.
