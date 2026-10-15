---
title: "Security scope"
sidebarTitle: "Security scope"
description: "Which code in LumenWipe is security-sensitive, why, who owns it, and the review it needs before it merges."
icon: "lock"
---

LumenWipe ends every close in an irreversible merge of a user's funds, so a small set of paths decides whether
that merge goes where the user asked. This page lists them by path, says why each is sensitive, and names the
owner role and the review a change there needs. It is the path list behind the closer-review rule in
[CONTRIBUTING.md](https://github.com/LumenWipe/lumenwipe/blob/main/CONTRIBUTING.md). The
[threat model](/threat-model) explains the threats these paths answer, and the [invariant register](/invariants)
says which of their guarantees a test proves.

`bun run check:docs` fails the build when a path below no longer exists, so a move or a rename has to update this
page in the same pull request. It does not check that the list is complete: a new sensitive file is added here by
the pull request that creates it.

## Owner roles

Roles, not people, so the page survives absences. A maintainer may hold more than one.

- **Verification owner**: the browser and playground trust anchors, client-side signing and its orchestration,
  and the SDK's close runner. Everything that decides what a user signs.
- **API owner**: transaction construction, the account reads `verify()` relies on, the two server-side Stellar
  signing keys, authentication and key issuance, and the contract and exchange registries.
- **Infrastructure owner**: the web server's proxy and Content Security Policy, CI, deploy and dependency
  configuration, and the documents and checks that define this scope.

## Security-sensitive paths

A file listed here stays in scope even when it sits under a directory the last section leaves out.

| Group                                 | Paths                                                                                                                                                                                                                                                                                                                                                                                    | Why it is sensitive                                                                                                                                                                                                     | Owner role           |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Client-side trust anchor              | `apps/web/lib/stellar/verify.ts`, `apps/web/lib/stellar/verify-revoke-allowance.ts`, `apps/web/lib/stellar/exit-expectations.ts`, `apps/web/lib/stellar/intent/`, `apps/web/lib/exchange-registry/`, `apps/web/config/networks.ts`                                                                                                                                                       | Decides whether an API-built transaction gets signed, including whether a destination needs the mediator and a memo, and for which network. Every other control assumes it rejects what the user did not ask for.       | Verification owner   |
| Client-side signing and orchestration | `apps/web/lib/stellar/signer.ts`, `apps/web/lib/wallet-kit/`, `apps/web/hooks/useCloseExecution.ts`, `apps/web/lib/stellar/signature-weight.ts`, `apps/web/lib/stellar/thresholds.ts`, `apps/web/lib/stellar/pre-auth-tx.ts`, `apps/web/lib/stellar/hash-x.ts`, `apps/web/lib/stellar/mediator.ts`, `apps/web/lib/stellar/fee-bump-sponsor.ts`, `apps/web/lib/stellar/submit-via-api.ts` | Holds a secret key in memory in the secret-key mode, signs, builds the expectations `verify()` checks against, and orders verify, sign, co-sign, sponsorship and submit. A wrong expectation here gets past `verify()`. | Verification owner   |
| Playground trust anchor and demo key  | `apps/playground/lib/verify.ts`, `apps/playground/lib/crypto.ts`, `apps/playground/lib/session-store.ts`, `apps/playground/lib/accounts.ts`, `apps/playground/lib/rate-limit.ts`, `apps/playground/lib/route-helpers.ts`, `apps/playground/app/api/`                                                                                                                                     | The playground's own, narrower verifier, and the server-side routes and helpers that encrypt, store, decrypt and use its throwaway demo key.                                                                            | Verification owner   |
| SDK close runner                      | `packages/sdk/src/close-engine.ts`                                                                                                                                                                                                                                                                                                                                                       | Drives every round of a close for integrators and the web, and calls the caller's verification before each signature.                                                                                                   | Verification owner   |
| Transaction construction              | `apps/api/src/lib/stellar/tx-builder/`, `apps/api/src/lib/close-api/`, `apps/api/src/lib/defi-exits/`, `apps/api/src/lib/soroswap/`, `apps/api/src/lib/xbull/`, `apps/api/src/close/`, `apps/api/src/lib/stellar/memo-required.ts`                                                                                                                                                       | Builds every unsigned transaction, DeFi exit and conversion a user is asked to sign, including the swaps built from outside quote services.                                                                             | API owner            |
| Account reads `verify()` relies on    | `apps/api/src/account/`, `apps/api/src/lib/stellar/account-state.ts`, `apps/api/src/lib/defi-positions/`                                                                                                                                                                                                                                                                                 | The native balance the mediator forward is held to, the signers and thresholds, and the DeFi positions an exit may touch all come from this read, so a wrong read moves what `verify()` accepts.                        | API owner            |
| Server-side signing keys              | `apps/api/src/mediator/`, `apps/api/src/fee-bump/`, `apps/api/src/lib/stellar/mediator-server.ts`, `apps/api/src/lib/stellar/fee-account.ts`, `apps/api/src/lib/stellar/validity-window.ts`                                                                                                                                                                                              | The only two Stellar signing keys the API holds: the mediator co-sign and the fee-bump sponsor.                                                                                                                         | API owner            |
| Authentication and key issuance       | `apps/api/src/auth/`, `apps/api/src/integrator/`, `apps/api/src/admin/`, `apps/api/src/common/guards/`, `apps/api/src/configure-app.ts`                                                                                                                                                                                                                                                  | API keys and their hashes, rate limiting, wallet sign-in sessions and their secret, self-serve and operator key issuance, rotation and revocation, and the middleware order that applies them.                          | API owner            |
| Contract and exchange registries      | `apps/api/src/lib/contract-registry/`, `apps/api/src/config/contract-registry.json`, `apps/web/lib/contract-registry/`, `apps/api/src/lib/exchange-registry/`, `apps/api/src/config/exchange-registry.json`                                                                                                                                                                              | Which contract code an exit may run against, which contracts the browser lets a user authorize, and which destinations need the mediator and a memo.                                                                    | API owner            |
| Web proxy and Content Security Policy | `apps/web/proxy.ts`, `apps/web/app/api/`, `apps/web/lib/api/server-client.ts`, `apps/web/lib/integrator/relay.ts`, `apps/web/lib/integrator/upstream.ts`                                                                                                                                                                                                                                 | The policy that keeps injected scripts away from the signing page, and the server-side code that holds the web's API key and forwards integrator sessions.                                                              | Infrastructure owner |
| CI, deploy and dependencies           | `.github/workflows/`, `apps/api/Dockerfile`, `apps/web/vercel.json`, `apps/playground/vercel.json`, `package.json`, `bun.lock`, `renovate.json`, `scripts/audit-gate.ts`, `scripts/audit-allowlist.json`, `scripts/security-tools.json`, `.gitleaks.toml`, `.gitleaksignore`                                                                                                             | What gates a merge, what ships in the image that holds the signing keys, what deploys with which credentials, which dependency versions are installed and how updates arrive, and what the security scans accept.       | Infrastructure owner |
| This scope and its checks             | `docs/security-scope.md`, `docs/threat-model.md`, `docs/invariants.mdx`, `scripts/check-docs-claims.ts`, `CONTRIBUTING.md`, `CLAUDE.md`                                                                                                                                                                                                                                                  | Removing a row here takes a path out of the closer-review rule, and these files state and check the security claims.                                                                                                    | Infrastructure owner |

## The closer-review rule

A pull request that touches any path above:

1. Says so in its description and names each group it touches.
2. Gets a security review of its diff before it is opened, recorded in the description: what was checked and
   what was found. Maintainers run their security review tooling for this; an outside contributor asks a
   maintainer to.
3. Gets an approving review from the owner of each group it touches, or, for a group whose owner is the
   author, from another maintainer. One maintainer holding several roles can approve for all of them. When no
   other maintainer is available, the pull request waits. The approver reads the whole diff of each group, not
   only its tests.
4. When it adds a close operation, a signing key, an adapter, a surface or an app boundary, updates the threat
   model and the invariant register in the same pull request.

The rule is applied by the author and the reviewer. As of 2026-10-13, GitHub does not enforce it: the repository
has no `CODEOWNERS` file and requires no approving review count, so the required CI checks are the only automatic
gate.

## Out of scope

These carry no fund path or key, so ordinary review applies:

- The playground's UI: `apps/playground/app/` and `apps/playground/components/`, except `apps/playground/app/api/`
  and the files listed above.
- The marketing pages: `apps/web/app/(marketing)/`.
- The docs site under `docs/`, except the pages listed above. For other pages, review covers their claims;
  `bun run check:docs` only confirms that the files, symbols and tests they name exist.
