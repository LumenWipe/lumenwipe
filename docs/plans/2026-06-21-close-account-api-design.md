# Close-account REST API and plan/transaction contract

- Status: Design approved, not yet implemented
- Date: 2026-06-21
- Branch: `docs/close-account-api-design`
- Base: `main` @ `4f025ee`
- Scope moves transaction-construction orchestration server-side. This is security-sensitive under `CLAUDE.md` (transaction construction, key handling, trust boundary). Flag explicitly in any implementation PR.

## Problem

Today the close logic lives in the browser. A `"use client"` hook (`hooks/useStepExecution.ts`) calls `buildStepXdrForPlan` (`lib/stellar/step-engine.ts`), which re-reads chain state and delegates to the pure `lib/stellar/tx-builder/*` to produce unsigned XDR; the client signs and submits straight to RPC. There is no `/plan` endpoint anymore — the read-only API routes only serve data RPC cannot (`/account`, `/paths`, mediator co-sign).

We want a public REST API (and, later, an SDK) so that closing an account is "call an endpoint, get an unsigned transaction back". The same contract must serve LumenWipe's own front-end and third-party integrators (wallets, agents) from day one. The API must accept the user's decisions (e.g. per-asset: convert to XLM vs return to issuer; confirmations), and the response format must accommodate closes that take more than one transaction (future DeFi position exits).

## Goals

- A versioned, network-scoped REST contract: `/v1/{network}/…`, `network ∈ public | testnet`.
- Stateless. The chain is the source of truth; every call re-reads live on-chain state. No server-side session store.
- One contract for both LumenWipe's front-end and third parties.
- A complete, human-reviewable preview of everything the close will do (`/plan`), independent of how many transactions it takes.
- The backend returns the unsigned XDR; keys never leave the client and signing stays client-side.
- A structured, verifiable `intent` per transaction, present from day one, so an SDK can later refuse to sign bytes that do not match what was declared.
- A response format that represents single- and multi-transaction closes uniformly.
- All human-readable strings in the API are English. Stable machine identifiers (`id`, `type`, `choice`, error `code`) are never translated.

## Non-goals

- The SDK itself and client-side verification (`verify()`). The API must be *verification-ready* now; the verifier ships later.
- Custody or signing on the server. The API only ever returns unsigned XDR and never accepts a secret key. `/submit` accepts already-signed XDR only.
- Soroban DeFi exit adapters (phase 2). The contract is designed to accommodate them; they are not built here.

## Trust model

The backend builds the unsigned XDR, but it is **not** a blind-trust point. Each transaction is returned with a structured `intent` describing exactly what the bytes do. The chosen model is zero-trust client verification (deferred to the SDK): the SDK re-decodes the raw XDR and asserts it matches the declared `intent` and the user's decisions before signing. Because keys stay client-side and signing is client-side, a compromised or buggy backend cannot move funds without the client signing — and the client will refuse to sign bytes that do not match the declared intent. The API carries the `intent` from day one so the contract does not change when the verifier lands.

## Endpoints

Three endpoints follow the natural flow. `/plan` and `/transactions` are pure functions of (chain state + inputs), so they are cacheable by `planHash` and safe to retry.

### `POST /v1/{network}/close/plan` — complete preview

Body: `{ source, destination?, decisions?[] }`. `destination` and `decisions` are optional, so a caller can preview "what holds this account open and what must I decide" from `source` alone.

Re-reads on-chain state and returns the full plan: every ordered step end-to-end (signers, data entries, offers, every asset disposition, future DeFi exits, trustlines, merge), the still-unresolved `decisionPoints`, `blockers`, a fee / freed-reserve estimate, a `planHash` (hash of resolved inputs + snapshot ledger, for idempotency and drift detection), and an `execution` breakdown of how many transactions it will take and why:

```jsonc
{
  "planHash": "a1b2…",
  "status": "ready",            // | "needs_decisions" | "blocked" | "complete"
  "steps": [ /* full ordered list, every action */ ],
  "decisionPoints": [ /* see below */ ],
  "blockers": [ /* see Errors */ ],
  "estimate": { "feeStroops": "300", "freedReserveXlm": "1.5" },
  "execution": {
    "estimatedTransactionCount": 3,
    "transactions": [
      { "order": 0, "covers": ["EXIT_BLEND"], "reason": "defi_dependency" },
      { "order": 1, "covers": ["CONVERT_ASSETS", "REMOVE_TRUSTLINES"], "reason": "op_batch" },
      { "order": 2, "covers": ["MERGE"] }
    ]
  }
}
```

This is the "everything that will happen → confirm" surface.

### `POST /v1/{network}/close/transactions` — bytes to sign

Body: `{ source, destination, decisions[], planHash? }`. Every `decisionPoint` must be resolved; a missing or invalid decision returns `422` with the offending points. Re-reads chain and returns an ordered list of unsigned transactions (see Multi-transaction model and Intent below).

### `POST /v1/{network}/submit` — optional convenience

Body: `{ signedXdr }`. Submits and polls, returns `{ hash, status }`. For integrators that do not want to talk to RPC directly; LumenWipe's front-end may keep submitting straight to RPC. Accepts signed XDR only — never a secret.

## Decision model

Each `decisionPoint` is self-describing, with options and an opinionated default (the API recommends, it does not force):

```jsonc
{
  "id": "asset:USDC-GA5ZSE…",        // stable; answers reference this
  "type": "asset_disposition",        // | "confirmation" | "choice"
  "subject": { "kind": "trustline", "asset": "USDC:GA5ZSE…",
               "balance": "120.50", "convertible": true },
  "options": [
    { "id": "convert_to_xlm", "recommended": true,
      "quote": { "estimatedReceive": "118.20", "path": ["USDC", "XLM"],
                 "source": "soroswap", "expiresAtLedger": 51234567 } },
    { "id": "return_to_issuer",
      "note": "Sends the balance back to the issuer; you receive no XLM." }
  ],
  "default": "convert_to_xlm",
  "required": true
}
```

Types covered from day one:

- `asset_disposition` — trustline with a balance: `convert_to_xlm` (carries a quote) vs `return_to_issuer`. If no route exists, `convertible: false` and the only valid option is `return_to_issuer`.
- `confirmation` — acknowledge something irreversible or non-obvious (e.g. "claimable balance of 5 XLM: claim it?", "asset has no route, will be returned to issuer").
- `choice` — generic, for the future (DeFi: "Blend position: withdraw to XLM / repay / leave").

Client answer in `decisions[]`:

```jsonc
{ "id": "asset:USDC-GA5ZSE…", "choice": "convert_to_xlm",
  "params": { "maxSlippageBps": 50 } }
```

`asset_disposition` maps directly onto the existing `AssetDisposition` type in `types/plan.ts`.

### Quotes are advisory, not binding

A quote applies only to `convert_to_xlm` and is the path-finding estimate for that conversion. It is returned so the user can decide informedly ("convert gives ~118 XLM vs return-to-issuer gives nothing") and so the front-end can render the option; displaying it is the consumer's choice (dust can be collapsed). It is **advisory** — the binding guarantee is the `minReceived` (derived from `maxSlippageBps`) baked into the path payment at build time.

The quote is **not** frozen between calls. The decision carries a slippage tolerance, not a fixed quote. `/transactions` re-quotes against the chain and sets `destMin` from the tolerance. If the route moved out of tolerance → `409 quote_drifted` with the fresh quote, and the client re-confirms. `/plan` returns quotes best-effort (and always sets `convertible`); the authoritative re-quote lives in `/transactions`.

## Multi-transaction model

The preview (`/plan`) is always complete and independent of execution mechanics. `/transactions` produces signable bytes and tries to return all of them at once.

`/transactions` accepts a `mode`:

- `mode: "all"` (default when safe) — returns every transaction at once, pre-built with incrementing sequence numbers. Applies whenever the only reason for multiple transactions is operation-count batching or fixed ordering — which covers almost every multi-transaction case. The caller signs them in sequence with no intermediate round-trips or decisions.
- `mode: "frontier"` (forced only when required) — only when a later transaction's *content* depends on the *on-chain result* of an earlier one (e.g. the exact XLM/asset amount a DeFi exit yields determines the next transaction's send amount). That content is genuinely unknowable until the earlier transaction confirms, so the API returns transactions up to the dependency boundary and sets `requiresAnotherCall: true`. `/plan` already flagged this via `reason: "defi_dependency"` and `estimatedTransactionCount`, so it is not a surprise.

Response shape:

```jsonc
{
  "planHash": "a1b2…",
  "status": "ready",
  "transactions": [
    {
      "id": "tx-1",
      "order": 0,
      "dependsOn": [],
      "xdr": "AAAA…",
      "networkPassphrase": "Test SDF Network ; September 2015",
      "sourceSequence": "120294…",
      "validUntilLedger": 51234600,
      "covers": ["CONVERT_ASSETS", "REMOVE_TRUSTLINES", "MERGE"],
      "intent": { /* see below */ }
    }
  ],
  "remaining": { "steps": 0, "requiresAnotherCall": false }
}
```

The full-chain-in-one-response model (pre-building dependent transactions with embedded results) was rejected as brittle: any unexpected state change, sequence drift, or stale embedded quote invalidates the rest of the batch. The frontier fallback re-derives from fresh chain state on the next call, which mirrors the existing `useSessionRecovery` reconcile-against-chain pattern and is self-healing on retry. For today's accounts the frontier is a single transaction (the fused close) and `remaining.steps = 0`.

## Intent

Each transaction carries a normalized, typed `intent` describing what the XDR does — for display ("this is what you will sign") and for verification (the SDK re-decodes the XDR and compares). Each operation is normalized to its safety-critical fields, not the full XDR:

```jsonc
"intent": {
  "summary": "Convert 1 asset to XLM, remove 1 trustline, and merge the account.",
  "source": "GSOURCE…",
  "fee": "300",
  "memo": null,
  "guarantees": {
    "mergeDestination": "GDEST…",          // account is merged HERE and nowhere else
    "paymentsOnlyTo": ["GDEST…", "GISSUER…"],
    "minXlmFromConversions": "118.20"
  },
  "operations": [
    { "type": "path_payment_strict_send",
      "sendAsset": "USDC:GISSUER…", "sendAmount": "120.50",
      "destination": "GSOURCE…", "destAsset": "XLM",
      "destMin": "118.20", "path": [] },
    { "type": "change_trust", "asset": "USDC:GISSUER…", "limit": "0" },
    { "type": "account_merge", "destination": "GDEST…" }
  ]
}
```

The SDK's later verification is three checks:

1. **XDR ↔ intent** — decode the raw XDR and require the operations to be exactly these, in order. Any operation in the XDR not in the intent (or with a different destination/amount) → refuse to sign. The intent is the allowlist of what the bytes may do.
2. **Guarantees** — `account_merge.destination === guarantees.mergeDestination === the user's chosen destination`; any payment / path payment goes only to an account in `paymentsOnlyTo`. This is what stops a compromised backend redirecting the merge.
3. **Decisions ↔ operations** — if the user chose `convert_to_xlm` for an asset, there must be a path payment for it with a `destMin` consistent with the slippage, and there must be no payment-to-issuer for it. This catches a backend that ignores or alters a decision.

## Errors, blockers, and drift

Consistent envelope; `message` always English:

```jsonc
{ "error": { "code": "quote_drifted", "message": "…", "details": { … } } }
```

Blockers are **not** HTTP errors. An account that cannot be closed is a valid result, not a `500`. Blockers go in the plan body as `blockers[]` with a `code` plus explanation (e.g. `exchange_destination_missing_memo`, `position_not_closable`) and the plan carries `status: "blocked"`. The API never exposes raw SDK error codes or stack traces (a `CLAUDE.md` invariant).

HTTP errors mean the request itself could not be processed:

- `422 unprocessable` — missing/invalid decisions → returns the offending `decisionPoints`.
- `409 quote_drifted` — route moved out of tolerance → returns the fresh quote; client re-confirms.
- `409 state_changed` — the chain changed since the plan (the `planHash` no longer matches) → re-plan and re-display.
- `400` malformed input, `404` account not found / unfunded, `502/503` upstream down (RPC / Horizon / paths).

**Drift detection.** The client passes the `planHash` it previewed to `/transactions`. If the account changed materially between preview and build → `409 state_changed`. This prevents signing a plan different from the one the user approved, which matters because the operation is irreversible.

**Mid-sequence failure.** Because the model is stateless + frontier with the chain as truth, there is no recovery endpoint: if transaction 2 of 3 fails, call `/transactions` again and it re-derives from on-chain state (transaction 1's effects persist). Retrying is idempotent by construction.

## Mapping onto the existing code

The pure `tx-builder/` was designed to be portable, so this is largely "move orchestration server-side without touching the pure core".

Reused unchanged:

- `lib/stellar/tx-builder/*` — stays pure and unit-tested, now invoked from the server.
- `buildPlan`, the `PlannedStep` / `AssetDisposition` types — `AssetDisposition` (convert / return-to-issuer) already models the `decisionPoints`.

Moved client → server:

- The orchestration in `lib/stellar/step-engine.ts` (`buildStepXdrForPlan`) moves into the `/close/*` handlers; on the server it reads RPC/Horizon directly instead of `fetch("/api/.../account")`.
- The read layer (`lib/se-api/`, `lib/stellar/account-live.ts`, `lib/stellar/horizon-adapter.ts`, `lib/stellar/rpc.ts`) lives server-side; today's read-only routes (`/account`, `/paths`) are absorbed by the new endpoints.

Shrinks:

- `hooks/useStepExecution.ts` stops building. It calls the API for plan + transactions, signs the returned XDR, and submits. Signing and keys stay client-side. The front-end becomes another client of the same contract.

New:

- An `intent` serializer (pure): built operations → normalized `intent`, and its inverse, decode XDR → normalized operation list. Used by the API for the preview now, and it is exactly the core of the SDK's future `verify()`. Same code, double use.

Preserved invariants: `tx-builder/` never receives network access; the API returns unsigned XDR only and never accepts a secret; the mediator co-sign (`/api/[network]/mediator/sign`) is unchanged.

## Testing

- Unit-test the `intent` serializer round-trip (build ops → intent, and XDR → normalized ops) and the three verification checks against tampered XDR (wrong merge destination, extra operation, ignored decision).
- Unit-test plan derivation and decision resolution (extends the existing `buildPlan` coverage); the same account state must always produce the same plan and `planHash`.
- Contract tests for each endpoint: `422` on unresolved decisions, `409 quote_drifted` / `state_changed`, blockers surfaced as data not `5xx`.
- Testnet integration tests for `/transactions` end to end (build → sign client-side → submit), reusing the existing e2e funding/friendbot helpers. Automated tests never touch mainnet.

## Out of scope / follow-ups

- The SDK and `verify()` implementation (the API is verification-ready; the verifier is a later workstream).
- DeFi exit adapters and the `frontier` multi-call path (phase 2). The contract accommodates them now.
- Auth / rate-limiting / API keys for third-party access (separate operational design).
- Quote-cost optimization in `/plan` (best-effort quotes vs. authoritative re-quote in `/transactions`).
