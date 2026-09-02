---
title: "STRIDE threat model"
sidebarTitle: "Threat model"
description: "A structured, per-surface STRIDE analysis of key handling, the API's two signing keys, transaction construction, and the client-side session layer."
icon: "shield-halved"
---

> This document formalizes what [Section 13](/architecture#13-security-model) of the technical architecture
> already narrates in prose. It is not a rewrite of that section - it restates the same design as a
> structured STRIDE analysis (Spoofing, Tampering, Repudiation, Information disclosure, Denial of service,
> Elevation of privilege) so a reader, an auditor, or the security-tooling remediation plan can check specific
> threats against specific mitigations, one surface at a time.

## 1. Scope and method

In scope, one STRIDE pass per surface:

1. Client-side key handling (wallet path and the secret-key advanced mode).
2. The client-side session layer (the `DemolishPhase` state machine and IndexedDB session store).
3. API transaction construction (the pure transaction-builder module).
4. The two backend signing keys: the mediator co-sign key, and the fee-bump sponsor key.

Out of scope, deliberately:

- **Read-only external data sources** (RPC providers, the Horizon-compatible enumeration endpoint, the
  Soroswap routing API, OctoPos). These carry availability risk, not custody risk - they cannot move funds -
  and are already addressed as a trust-minimization concern in [Section 14](/architecture#14-trust-minimization-and-decentralization),
  not repeated here.
- **A third-party penetration test or formal audit.** Tracked separately, deferred by design (epic #166),
  outside this document's scope.
- **Infrastructure-level threats** (cloud provider compromise, CI/CD supply-chain attacks against the deploy
  pipeline). Covered by [Section 15](/architecture#15-infrastructure-and-deployment)'s deployment model, not
  re-analyzed here.

Every mitigation cited below is either quoted from `docs/architecture.md` or traced to the specific source
file that implements it - this document verifies existing controls, it does not propose new ones.

## 2. Surface 1: client-side key handling

Two paths: the wallet path (`stellar-wallets-kit`, primary) and the secret-key advanced mode
(`apps/web/lib/stellar/signer.ts`), for keys not held in any wallet.

| Threat category        | Threat                                                                                               | Mitigation                                                                                                                                                                                                                                                                                      |
| ---------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spoofing               | A malicious page or script impersonates the signing UI to harvest a key                              | The secret-key input is a password field rendered only within the signing step's own component tree; a strict CSP (`docs/architecture.md` §13.1) blocks inline scripts and external script sources that could inject a fake input                                                               |
| Tampering              | A compromised dependency reads the key out of memory                                                 | Lockfile-pinned dependencies, audited in CI; no dependency permitted that needs dynamic code execution (§13.1)                                                                                                                                                                                  |
| Repudiation            | N/A - key handling does not produce an audit trail claim                                             | Not applicable to this surface                                                                                                                                                                                                                                                                  |
| Information disclosure | The key persists somewhere it can later be read (storage, logs, network)                             | `SecretKeySigner` (`apps/web/lib/stellar/signer.ts`) holds the parsed `Keypair` only as a private instance field; nothing in the signing path writes to `localStorage`, `sessionStorage`, IndexedDB, cookies, or any outbound request (§13.2)                                                   |
| Denial of service      | N/A - unavailability of this surface blocks only the current user's own close, not a shared resource | Not applicable at this trust boundary                                                                                                                                                                                                                                                           |
| Elevation of privilege | A held key outlives the session and gets reused for an action the user didn't confirm                | Wiped on completion, on abort, on navigation away from the flow, and on explicit "Forget key"; for multisig, keys are gathered one at a time and only cleared by switching signer or forgetting, not per signature (§13.2). The component holding the key unmounts on leaving the signing step. |

Wallet-path signing carries a narrower version of the same threats: the key never enters the application at
all, so Information disclosure and Tampering against in-memory key material do not apply - the residual
threats are wallet-extension compromise and CSP bypass, both outside this surface's boundary.

## 3. Surface 2: the client-side session layer

`apps/web/store/demolish.ts` (the `DemolishPhase` state machine) and `apps/web/lib/session/store.ts` (the
IndexedDB-backed session store, via `idb`), plus `verify()` (`apps/web/lib/stellar/verify.ts`) as the trust
anchor gating every signature this layer eventually authorizes.

| Threat category        | Threat                                                                                       | Mitigation                                                                                                                                                                                                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spoofing               | A crafted API response gets signed as if it matched the user's own request                   | `verify()` sources its expected destination, memo, asset, and amount from the user's own inputs, never from the API response (§13.1); a mismatch aborts before signing                                                                                                                   |
| Tampering              | A resumed session executes a step the user never reviewed                                    | The `PREFLIGHT_COMPLETE → STEP_EXECUTING` transition only fires from the `/review` page's own explicit confirmation; nothing is written to the resumable session store before that fires, so a tab closed mid-review has nothing to resume (§13.3)                                       |
| Repudiation            | The user disputes having authorized a step that in fact ran                                  | Every destructive step requires an explicit acknowledgment naming the affected entry/balance before submission; the tool never auto-submits (§13.3)                                                                                                                                      |
| Information disclosure | The persisted session record leaks key material or other sensitive data from IndexedDB       | Verified directly against `apps/web/lib/session/store.ts`: the `SessionRecord` schema persisted via `saveSession`/`loadSession` carries plan and progress state, not signing material - consistent with §13.2's claim that the key never touches any storage layer                       |
| Denial of service      | A malformed or corrupted session record blocks the user from resuming or restarting          | The API is stateless per round and re-reads live account state every call (`remaining.requiresAnotherCall`); an interrupted close resumes by calling again rather than reconciling stored server-side progress, so a corrupted local session degrades to "start over," not a stuck state |
| Elevation of privilege | An unrelated operation gets appended to a transaction and signed alongside the reviewed plan | `verify()`'s allowlist rejects any operation shape it does not recognize (`docs/architecture.md`, "Consequence for any new close operation"); an unknown operation aborts signing rather than being silently accepted                                                                    |

## 4. Surface 3: API transaction construction

The API's transaction-builder module (`apps/api`) is a pure module by design invariant - state in, unsigned
envelopes out, no network side effects (CLAUDE.md, "Hard invariants") - which is what makes it possible for
`verify()` to treat its output as untrusted input rather than a peer.

| Threat category        | Threat                                                                                                                     | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spoofing               | A compromised or buggy API builds a transaction that diverts funds to an unintended destination                            | `verify()` re-derives every expected value from the user's own choices and never signs bytes it did not itself verify (§13.1); a compromised API cannot get funds diverted through the builder alone                                                                                                                                                                                                                                           |
| Tampering              | The builder is fed stale account state and constructs a transaction against on-chain reality that has since changed        | The API re-reads exact on-chain state over RPC immediately before building (CLAUDE.md, "Hard invariants" - "Never build or sign from indexer data alone")                                                                                                                                                                                                                                                                                      |
| Repudiation            | N/A - the builder does not itself authorize anything; authorization happens at signing                                     | Not applicable to this surface                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Information disclosure | Builder errors leak internal state (stack traces, SDK error codes) to the client                                           | User-facing errors are plain language; raw SDK codes or stack traces never surface (CLAUDE.md, "Hard invariants")                                                                                                                                                                                                                                                                                                                              |
| Denial of service      | A position that cannot be safely closed causes the builder to fail unsafely (partial execution, silent skip)               | A position or step that cannot be closed safely surfaces as an explained blocker, never silently skipped (CLAUDE.md, "Hard invariants")                                                                                                                                                                                                                                                                                                        |
| Elevation of privilege | A `SetOptions` operation the builder emits adds a signer or raises thresholds, silently expanding control over the account | `verify()`'s allowlist specifically asserts `SetOptions` never adds a signer or raises thresholds (§"The trust boundary moved to verify()"); the one check sourced from the API's own trust domain rather than the user - that a signer removal targets a signer that actually exists - is cross-checked against a separate account-state read, not the transaction itself, so it also catches a builder bug independent of `verify()` (§13.1) |

## 5. Surface 4a: backend signing key — mediator co-sign

`apps/api/src/mediator/mediator.controller.ts` and `mediator-validation.ts`. The mediator is the one signing
key the API holds today; it co-signs only the forwarding payment of the exchange-mediator flow
([Section 11](/architecture#11-the-mediator-account-flow-for-exchanges)).

| Threat category        | Threat                                                                                                                                    | Mitigation                                                                                                                                                                                                                                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spoofing               | A caller submits a transaction shaped to make the mediator sign something other than its own forward payment                              | `MediatorController.sign` requires exactly two operations - `accountMerge` into the mediator, `payment` sourced from the mediator - and rejects any other shape (`transaction_structure_not_allowed`)                                                                                                |
| Tampering              | The forward payment's destination or amount is altered after the user set them                                                            | The mediator signs the exact transaction it validated; changing either after co-signing invalidates the merge signature the user already applied, since both operations share one envelope                                                                                                           |
| Repudiation            | The mediator denies having co-signed a forward it did in fact sign                                                                        | The mediator's signature is a standard ed25519 signature over the envelope, verifiable on-chain like any other signer - out of scope to add further non-repudiation controls here                                                                                                                    |
| Information disclosure | The mediator's secret key leaks through logging or an error path                                                                          | The mediator secret lives only in the API's environment (`MEDIATOR_SECRET_*`), never in the browser, and is used exclusively inside `getMediatorKeypair` (§13.2)                                                                                                                                     |
| Denial of service      | The mediator is spammed with malformed transactions to exhaust request budget                                                             | Per-key rate limiting at the service layer (`@ApiResponse 429`); malformed requests fail fast on `Transaction` XDR parse before any account-state read                                                                                                                                               |
| Elevation of privilege | The mediator is tricked into paying its own fee or consuming its own sequence number, or forwarding more than the merge actually delivers | `sign` explicitly rejects the mediator as `tx.source` or as the merge's source (`transaction_structure_not_allowed`); `forwardExceedsMergedBalance` bounds the forward to the merged account's native balance minus fee, checked against a balance read at co-sign time, fail-closed on read failure |

### Known residual risk: mediator forward TOCTOU

`forwardExceedsMergedBalance` (`apps/api/src/mediator/mediator-validation.ts`) documents, in its own source
comment, a genuine time-of-check/time-of-use gap: the bound is checked against a balance read taken at
co-sign time, but the merge's actual delivery is decided at submit time, which the caller controls. An
adversary who controls the merged account can drain it after co-signing (draining does not consume the
co-signed transaction's sequence number, since it is a separate operation from a separate account), then
submit - so `op0` (the merge) delivers close to nothing while `op1` (the forward) still pays out the amount
that was valid at co-sign time, sourced from the mediator's own balance rather than the merge.

This check is explicitly defense-in-depth, not a complete guarantee, against that active-adversary case. The
primary control is operational, not code-level: **the shared mediator is funded to its base reserve only and
holds no spendable surplus**, so even a successful exploitation of this gap has nothing to forward beyond
dust. The check in code stops the passive cases - a client bug, rounding dust, or a naive over-forward -
and raises the bar for the active case. This residual risk is carried forward into the summary table in
Section 7 as an accepted risk with an operational (not code) compensating control, which is the shape
`#171`'s remediation plan expects findings to already be in.

## 6. Surface 4b: backend signing key — fee-bump sponsor (planned)

**Status: designed, not yet implemented.** This surface is committed in
[Section 8.1](/architecture#81-sponsored-fees-closing-accounts-that-cannot-pay-their-own-way) of the
architecture doc but its endpoint ships under a separate, still-open issue (#164, epic #159). It is included
here per this issue's scope - the STRIDE model must cover the design the moment it exists in the repository's
committed architecture, not wait for the implementing PR - but every row below describes a commitment, not
verified running code, and must be re-verified against the actual implementation once #164 merges.

| Threat category        | Threat                                                                                                              | Designed mitigation                                                                                                                                                                                                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spoofing               | An unrelated transaction gets the fee account's sponsorship                                                         | The API sponsors an inner transaction only if every operation matches an explicit wind-down allowlist (`ChangeTrust` limit 0, `ManageSellOffer`/`ManageBuyOffer` amount 0, `ManageData` removals, `SetOptions` signer normalization, `ClaimClaimableBalance`, conversion payments, `AccountMerge` to the session destination) |
| Tampering              | The API alters an operation, amount, or destination while wrapping the fee-bump envelope                            | The inner transaction's own signature covers its contents; the API signs only the outer fee-bump envelope, so altering the inner transaction invalidates the user's signature before the fee account ever pays                                                                                                                |
| Repudiation            | N/A - same reasoning as the mediator key: the outer signature is independently verifiable                           | Not applicable beyond standard signature verification                                                                                                                                                                                                                                                                         |
| Information disclosure | The fee-account secret leaks the same way any server-side secret could                                              | Same isolation pattern as the mediator secret: environment-only, never transmitted to the browser                                                                                                                                                                                                                             |
| Denial of service      | The fee account's operational float is drained by repeated sponsorship requests, denying the feature to other users | The outer fee is capped per transaction; requests are rate-limited per account and per IP; the fee account carries a daily spend cap with alerting                                                                                                                                                                            |
| Elevation of privilege | A sponsored transaction is replayed to drain the fee account a second time                                          | Structurally impossible: the inner transaction consumes the source account's own sequence number, so a resubmission after the first successful submission fails at the network level, not at the API's validation                                                                                                             |

## 7. Known residual risks (summary)

| Risk                                                                                                                                                                            | Surface                                  | Compensating control                                                                                                                         | Status                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Mediator forward TOCTOU: an adversary who controls the merged account can drain it between co-sign and submit, so the forward pays out against a balance that no longer arrives | Mediator co-sign (Section 5)             | Operational: the mediator is funded to base reserve only and holds no spendable surplus                                                      | Accepted - code-level check is defense-in-depth only                                                               |
| One `verify()` check (signer-removal target existence) is sourced from the API's own state read rather than the user's input                                                    | API transaction construction (Section 4) | A wholly compromised API could in principle keep that read and the transaction consistent with each other; every other check is user-sourced | Accepted - documented in `docs/architecture.md` §13.1 as the one exception to "expected values come from the user" |

Neither risk is new: both are already narrated in `docs/architecture.md`. Restating them here is the point of
formalizing the threat model - they are now indexed by surface and category instead of embedded in prose, and
this is the table #171's tooling remediation plan cross-checks its own findings against.

## 8. Coverage cross-reference

What already holds under automated test, as of this document, not just what is designed:

| Surface                                                                                             | Test coverage                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client-side key handling                                                                            | `apps/web/lib/stellar/signer.ts` signer implementations (secret-key, hash(x) preimage, wallet-kit delegate)                                                                                                                                                                                              |
| Client-side session layer / `verify()`                                                              | `apps/web/tests/unit/verify.test.ts`, `apps/web/tests/unit/verify-revoke-sponsorship.test.ts`                                                                                                                                                                                                            |
| API transaction construction                                                                        | Unit tests over the transaction builder (highest-coverage module per §17) plus the adversarial suite below                                                                                                                                                                                               |
| Mediator co-sign                                                                                    | `apps/api/tests/unit/mediator-validation.test.ts`, `apps/api/tests/unit/mediatorMerge.test.ts`                                                                                                                                                                                                           |
| Adversarial/hostile-state coverage (cross-cutting, exercises the builder and verification together) | `apps/api/tests/adversarial/`: sponsoring accounts, the 1000-subentry maximum, revoked trustlines, multisig with hash(x)/pre-auth signers, undercollateralized vaults, queued backstop withdrawals, high-slippage conversions, and lost-confirmation retry safety - running in CI on every change (#191) |
| Fee-bump sponsor                                                                                    | None yet - endpoint not implemented (#164); this row must be filled in as part of that PR                                                                                                                                                                                                                |

## 9. Maintenance

This document goes stale the same way `docs/architecture.md`'s trust boundary does: **a new close operation,
a new signing key, or a new adapter needs a STRIDE entry added here in the same pull request that introduces
it**, not as a follow-up. In particular:

- A new operation shape added to the builder and to `verify()`'s allowlist (CLAUDE.md, "Consequence for any
  new close operation") gets a row in Section 4's Elevation of privilege threat.
- A new server-side signing key gets its own subsection under Section 5/6's pattern before it ships, the same
  way this document covers the fee-bump sponsor ahead of its implementation.
- A new DeFi protocol adapter that introduces its own invariants (`docs/architecture.md` §9.9) is covered by
  those invariants directly; it only needs an entry here if it changes what the API signs or holds.

Once #164 (the fee-bump endpoint) merges, Section 6 must be re-verified against the actual implementation and
re-labeled from "designed" to verified, with its coverage row in Section 8 filled in.
