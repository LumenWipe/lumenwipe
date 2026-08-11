# Multisig hardening — design spec

Date: 2026-08-11
Status: approved, not yet implemented

## Problem

LumenWipe's close flow structurally assumes a single ed25519 signer authorizes and submits
every transaction. `apps/api` already reads all four Stellar signer types (ed25519, hash(x),
pre-auth-tx, ed25519 signed-payload) into `AccountState` and already builds removal operations
for all four (`apps/api/src/lib/stellar/tx-builder/signers.ts`) — the *building* side works. The
gap is entirely on the *signing* side:

- `apps/web/lib/stellar/intent/serialize.ts:45-53` collapses a `SetOptions` signer down to a bare
  `signerWeight` number, discarding which signer type/key is being touched. `verify()`
  (`apps/web/lib/stellar/verify.ts:107-119`) therefore judges the operation in isolation — it has
  no notion of the account's actual signer set or thresholds.
- `apps/web/lib/api/close-engine.ts` and `apps/web/hooks/useCloseExecution.ts` sign a transaction
  exactly once and submit immediately; there is no loop that accumulates signatures from multiple
  wallets/keys until an account's threshold is met.
- `apps/web/store/demolish.ts:142` computes `requiredSignatureCount` from `thresholds.med` on every
  account-state load, but nothing ever reads it — dead state, evidently a stub left for this work.
- hash(x) and pre-auth-tx signers have no path at all: nothing lets a user contribute a preimage
  or a pre-authorized transaction toward a threshold.
- `docs/architecture.md` §6.3 and §13.2 already narrate the target design in prose ("the tool
  collects signatures from several keypairs or wallets in sequence on the same envelope until the
  account thresholds are met") as if it were shipped. It is not. §23 lists it as an open risk:
  *"hash(x) and pre-auth transaction signers cannot be signed automatically; define the manual
  pre-image and pre-auth paths."* This epic is that definition and implementation, plus closing the
  doc/reality gap.
- No unit, integration, or E2E test exercises multiple signers on one envelope today, despite
  §17 already listing "the multisig path" as an E2E target and "multisig account closed with
  multiple keys" as an MVP-tranche acceptance criterion (§19).

## Goal

Ship signature gathering across several wallets and keys on one envelope for ed25519 signers, with
hash(x) and pre-auth-tx signers surfaced and satisfiable through explicit manual-path UI, so a
2-of-3 (or any N-of-M) multisig account can be closed end to end on testnet.

## Principles

- **Single continuous session, not async handoff.** Signature accumulation happens within one
  browser session: connect wallet A, sign, switch to wallet B (or secret-key mode), sign again onto
  the same envelope, submit once the transaction's actual required weight is met. No cross-device
  handoff, no QR/export-import flow, no new persisted state before a step confirms on-chain —
  consistent with the existing "nothing resumable persists before execution" rule (#73). This
  matches both the architecture doc's own description and the "recorded demo, one operator, two
  wallets" acceptance criterion.
- **Threshold is per-transaction, not per-account.** Stellar's low/med/high threshold categories
  depend on which operations a transaction contains (e.g. `AccountMerge` and signer-changing
  `SetOptions` need the high threshold; most other operations need medium). The engine must compute
  the actual required weight per transaction, not assume a single account-wide number.
- **Every new signature-contribution path stays inside the trust boundary where structurally
  possible.** hash(x) preimages are applied client-side to an already-`verify()`-approved envelope
  and don't change its operations, so they don't weaken `verify()`. A pre-auth-tx signer is
  categorically different — it's satisfied by submitting an exact pre-existing transaction the API
  never built, so it cannot go through the normal build-then-verify pipeline. That path is an
  explicit, narrow, second-reviewer-flagged exception, never silently trusted.
- **No silent skips.** A signer the app cannot help satisfy, or a pre-auth XDR that doesn't match,
  surfaces as a plain-language blocker, never a quietly skipped step.
- **Each issue leaves the code ready for the next.** Types, state, and UI hooks introduced in one
  issue are the ones the next issue consumes, called out explicitly in that issue's tasks. Any bug
  found in the surrounding code while doing the work is fixed in the same issue, not filed
  separately.
- **Any new close operation or signature path touches `verify()`'s allowlist too**, per CLAUDE.md's
  trust-boundary invariant.

## Current → target

| Area | Current | Target |
|---|---|---|
| Signer identity through the pipeline | Collapsed to a bare weight number in `intent/serialize.ts` | Signer type + key preserved end to end; `verify()` reasons about the account's actual signer set/thresholds |
| Signature collection | One `signAndSubmit`, one signer, immediate submit | Threshold-aware loop: accumulate signatures from N signers until the transaction's actual required weight is met |
| hash(x) signers | Detected/read only; removal op exists but nothing can satisfy the signer to reach threshold | Manual preimage input, hash-validated, applied via `signHashX`, feeds the same accumulation state |
| pre-auth-tx signers | Same as above; structurally different (satisfied by exact tx match, not a signature) | Manual pre-authorized-XDR input, hash-validated against the signer key, explicit reduced-trust path since the API never built it |
| Test coverage | No multisig unit/integration/E2E coverage anywhere | Hostile-XDR unit tests, testnet integration with a live N-of-M account, Playwright E2E, recorded 2-of-3 demo |

## Sub-issues (in order)

### 1. Preserve signer identity through the close pipeline

Depends on: nothing (foundation).

Fixes `apps/web/lib/stellar/intent/serialize.ts:45-53` dropping signer type/key to a bare
`signerWeight`; extends the `set_options` variant of `IntentOperation`
(`packages/types/src/close-api.ts`) to carry the signer type and key; extends `verify()`'s
`CloseExpectation` (`apps/web/lib/stellar/verify.ts`) with the account's actual signer set and
thresholds so it judges a `SetOptions` op against real account state instead of in isolation.
Replaces the dead `requiredSignatureCount` (`apps/web/store/demolish.ts:142`) with real
per-operation threshold computation (or removes it if issue 2 supersedes it directly — decide
during implementation, whichever avoids a second dead stub). Confirms ed25519 signed-payload
(CAP-40) is already fully enumerated/removed end to end (it is, per `signers.ts:25-29` and
`account.ts:42-47` — this issue's job is to verify that finding still holds and there's no gap in
the *client* side surfacing it, since #1 is where signer-type fidelity is being fixed anyway).

**Prepares:** every later issue needs signer type/key and account threshold context available in
`verify()`/intent types; this issue is where that context is introduced.

### 2. Per-operation threshold computation + signature-accumulation engine

Depends on: #1.

Computes which threshold category (low/med/high) a transaction actually needs, from its operation
set, using the account's `thresholds` read in #1. Extends the `TransactionSigner` abstraction
(`apps/web/lib/stellar/signer.ts`) to support adding a signature to an already-partially-signed
envelope, not only signing a fresh one. Extends `close-engine.ts` / `useCloseExecution.ts`'s round
loop: after each signature, compare accumulated weight (sum of weights of signers whose keys appear
in the envelope's signature hints, matched against the account's known signer list) against the
required threshold; submit only once met, otherwise request another signer. Unit-tested threshold
math: single signer meets low, needs two for high, mixed weights, exact boundary cases.

**Prepares:** issue 3's UI only needs to call "sign with this signer" and read a
remaining-weight/eligible-signers state this issue produces.

### 3. Multi-wallet switch UI + signing progress

Depends on: #2.

Lets the user reconnect a different wallet (via the existing Stellar Wallets Kit integration from
#95) or drop to secret-key mode mid-signing, without losing the accumulated envelope. Shows
progress (weight collected vs. required) and which of the account's known signers haven't
contributed yet. Audits the current signing-step component for any place that still assumes
"one signature and done" and fixes it as part of this issue.

**Prepares:** issues 4 and 5 plug their manual-input paths into this same progress/state UI rather
than inventing a parallel one.

### 4. hash(x) signer support: detection + manual preimage input

Depends on: #3.

Detects hash(x) signers in the account's signer set and surfaces them in the review/signing UI
with a plain-language explanation of what they are and why they can't be satisfied by a connected
wallet. Adds a validated preimage input: hashes the user's input and confirms it matches the
signer's key before applying it via the SDK's `Transaction.signHashX` (or equivalent decorated-
signature construction) to the accumulated envelope, feeding the same weight-accumulation state
from #2/#3.

### 5. pre-auth-tx signer support: detection + manual pre-authorized-transaction path

Depends on: #3 (not #4 — independent of the hash(x) path).

**Security-sensitive** — flag for a second reviewer. Detects pre-auth-tx signers and surfaces them
with an explanation that they work fundamentally differently: they're satisfied only by submitting
the *exact* transaction that was pre-authorized in advance (its hash equals the signer key), not by
adding a signature to the API-built envelope. Adds a manual path: the user pastes their own
pre-authorized transaction XDR; the app computes its hash and validates it matches a signer
currently on the account, applies the same intent checks `assertCloseIntent` already performs where
they're structurally applicable (destination, no unexpected operations), and routes it to
`/submit` directly rather than through the normal build-then-sign round — with an explicit UI
warning that this XDR was not built by the API and therefore isn't backed by the same
build-time guarantees as the rest of the flow. This is the one path in the epic where `verify()`'s
"never trust API-supplied values, only the user's own inputs" guarantee has a structural exception
(the transaction itself is user-supplied), and that exception must be visible to the user, not
silent.

### 6. Hardening pass: hostile-XDR tests, testnet integration, Playwright E2E, docs, demo

Depends on: #4, #5.

**Security-sensitive** — flag for a second reviewer. Adds hostile-XDR unit tests for `verify()`
covering a multisig round specifically (an op that tries to smuggle in an added signer or raised
threshold disguised inside a partially-signed envelope). Adds a testnet integration test: a freshly
Friendbot-funded account configured via `SetOptions` into an N-of-M multisig at test setup, full
close driven against live state (matches the existing integration-test pattern of fresh accounts
per run, §17). Adds the Playwright E2E for "the multisig path" already named as a target in §17.
Corrects `docs/architecture.md` §6.3/§13.2 (currently narrate the target design as already shipped)
to match the actual implementation, and resolves the §23 "Multisig signer types" open-question
entry. Closing deliverable: a recorded demo of a 2-of-3 multisig account closed on testnet using
two different wallets.

## Deferred

- Async/cross-device multi-party signing (export XDR, QR handoff, or a shareable signing-request
  link) — the brief and the architecture doc both describe a single continuous session; a
  multi-device flow is a different, larger feature with its own persistence and security questions.
- A generalized "any weird signer state" recovery UI beyond the four Stellar signer types — out of
  scope until a real account state surfaces something not covered by the four types.
- Building or configuring a *new* multisig account — LumenWipe only closes accounts; setting one up
  is out of scope by the product's own definition.

## Labels

- Epic: `epic`, `area:web`.
- Issues 1-4, 6: `enhancement`, `area:web` (issue 1 also touches `packages/types` and a small piece
  of `apps/api`'s existing account read — no `area:api` label needed since no API behavior changes,
  only what's already read gets surfaced correctly).
- Issues 1, 5, 6: additionally `security`, given the trust-boundary and fund-adjacent nature flagged
  above.
