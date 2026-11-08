# Changelog

All notable changes to `@lumenwipe/sdk` are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[Semantic Versioning](https://semver.org/). See [`RELEASING.md`](../../RELEASING.md) for how a
release is cut.

## [Unreleased]

### Added

- `client.batchPlan(body, network?)` for `POST /v1/{network}/close/batch-plan`: up to 20
  accounts planned into one shared destination, read-only. Retried like the other stateless
  posts. New type `BatchPlanRequest`.
- `client.getExchangeRegistry()` for `GET /v1/config/exchange-registry`, retried like the other
  reads. New types `ServedExchangeRegistry` and `ExchangeRegistryEntry`.
- `client.healthDeep()` for `GET /health/deep`. A degraded service answers 503, thrown as a
  `LumenWipeApiError` whose `body` is the `HealthDeepResponse` with `status: "error"`; it is never
  retried. New types `HealthDeepResponse` and `HealthDeepIndicator`.
- `client.getStats(network?)`, `client.getStatsFeed(network?)` and
  `client.recordMerge(txHash, network?)` for the `/v1/{network}/stats` routes. New type
  `RecordMergeRequest`.
- `LumenWipeIntegratorClient`, a separate entry point for a wallet's own API keys: `challenge`,
  `session`, `listKeys`, `createKey(token, { label?, networks? })`, `revokeKey` and `rotateKey`.
  It takes no API key and never sends one; the key calls send only the session token, and a key
  id is percent-encoded. Creating, revoking and rotating a key are never retried. New types
  `LumenWipeIntegratorClientOptions`, `IntegratorChallengeResponse`, `IntegratorSessionRequest`,
  `IntegratorSessionResponse`, `CreateIntegratorKeyRequest`, `IntegratorKeyRecord`,
  `IntegratorKeyListEntry`, `IntegratorKeyUsage`, `IntegratorOwnerUsage`, `IntegratorKeyList`,
  `IssuedIntegratorKey` and `RevokedIntegratorKey`.

- The error codes `key_network_not_allowed` (403: the API key is limited to other networks),
  `invalid_label` and `invalid_networks` (400, from `POST /v1/integrator/keys`). Types only; no
  runtime change.
- `client.closeDelivered(destination, hashes, network?)`: the XLM confirmed close transactions
  delivered to `destination`, read by the API from each transaction's ledger result. An entry
  that cannot be read as delivered comes back as `unavailable` with its `reason`, never thrown,
  and `totalStroops` is set only when every entry is `delivered`. Retried like the other reads.
- The types `CloseDeliveredResponse` and `CloseDeliveredEntry`, for
  `GET /v1/{network}/close/delivered`: the XLM confirmed close transactions delivered to their
  destination, one entry per hash, with `totalStroops` only when every entry is `delivered`.
  Types only; no runtime change.
- `runClose` takes an optional `onProgressEvent(event)`. It is told each step of the close: a
  `preparing` event before each round is fetched, then `verifying`, `awaiting-signature`,
  `submitting` and `confirmed` for each transaction, carrying `round`, `txIndex`, `txCount`,
  `covers` and `moreRoundsExpected`. Each event is a fresh object, and a callback that throws or
  rejects cannot stop the close. `onProgress` messages are unchanged. New types
  `CloseProgressEvent`, `CloseProgressPhase`, `CloseRoundProgress` and
  `CloseTransactionProgress`. `PendingRound` gains optional `round`, `txIndex` and `txCount`, set
  by `runClose`, so a resumed close keeps its numbering.
- `CloseTransactionsRequest.memoType` (`"text"` or `"id"`): the type of `memo`. A destination the
  exchange registry does not list uses it, `text` when omitted; a listed exchange keeps the
  registry's type and answers `422 invalid_memo` with `details.memoType` when another is named.
  An unknown value is `400 invalid_body` and `"hash"` is `422 unsupported_memo_type`. An id memo
  with a leading zero is now `422 invalid_memo`: the network would keep only the number. Types
  only; no runtime change.
- `PhoenixLpPosition.shareToken` and `FxdaoCdpPosition.debtToken`: the contract of the token a
  position's exit moves, read from the pool's `CONFIG` and the vault's currency. Types only; no
  runtime change.
- The types `TokenQuoteFlag` and `TokenUnquotedReason` are exported, with the error code
  `conversion_impact_not_acknowledged`. A Soroban token's `subject.quote` carries `priceImpactBps`,
  `flags` and an optional `runnerUp`; a flagged conversion is not recommended and needs its
  `conversion_impact:<contract>` decision answered `acknowledged` with the convert answer's
  `params.minAmountOut`. A token with no quote carries `subject.reason`. Types only; no runtime
  change.
- The type `ClassicConversionQuote` is exported: the `quote` a convertible classic asset's
  `asset_disposition` subject already carries (`estimatedReceive` and `minAmountOut`, in stroops).
  Types only; no runtime change.
- `runClose` takes an opt-in `reconcile` and a `prepare` step. With them, an unknown submit outcome
  is settled by the hash the client computed: the same bytes are sent again at most
  `SUBMIT_RESEND_ATTEMPTS` (2) times, then the hash is looked up, then `CloseOutcomeUnknownError`
  carries a submission to pass back as `reconcile.unresolved`. `CloseTransactionFailedError` reports
  a failure on the ledger. `resolveSubmission`, `isSubmitRefused` and `submissionClosesAccount` are
  exported. Without `reconcile`, nothing is sent twice. `client.submit` is still never retried.
- `DemolishPhase` gains `STEP_UNCONFIRMED`.
- `client.getTransaction(hash)` looks a transaction up by hash without sending anything, and
  `client.closeStatus(source)` reports a close's phase and remaining work from live state. Both
  are retried like every other read. `closed` from `closeStatus` is informational: it never proves
  that a given close finished.
- The types `SubmitPendingDetails`, `TransactionLookupResponse`, `CloseStatusResponse` and
  `CloseStatusRemaining` are exported.
- Error code `state_changed` (409) from `close/transactions` and `close/plan`: the account changed
  between the API's read and its build, so nothing was built. Plan again.
- `runClose` fetches a round refused as `state_changed` again, at most `STATE_CHANGED_REFETCHES`
  (2) times, each after waiting `STATE_CHANGED_REFETCH_DELAY_MS` (3000 ms, about one ledger
  close), since each call re-reads the account and a read provider can lag a transaction that just
  confirmed. `CloseEngineDeps.sleep` replaces the timer, for tests. If it is still refused, `runClose` throws the
  new `CloseStateChangedError`: nothing was submitted for that round, so plan again and run the
  close from the new plan.
- `CloseTransactionsRequest.planHash` and `CloseEngineDeps.planHash`: the hash of the plan the
  user reviewed. `close/transactions` answers `409 state_changed` when the account's sequence or
  the answers differ from those the plan was built from, and `400 invalid_plan_hash` when it is not a 64-character hex string. `runClose`
  sends it until the first transaction of the run confirms and never after, and does not fetch a
  round again that was refused against it.
- `getTransactions` now receives `{ planHash }`; a function that takes no argument still works.
- `AccountState.snapshotLedger`: the latest ledger the account read reflects, when the provider
  reports one.
- `ErrorCode` gains `time_bounds_required` and `transaction_expired`, returned by the mediator
  co-sign and the fee sponsor for an envelope with no expiry, too long a validity or one that has
  expired; `sponsor_source_unusable`, returned by the fee sponsor when the inner transaction is
  not the next one of an existing account; and `sponsorship_budget_exhausted` (429), returned by
  the fee sponsor once a daily budget is spent.
- `TransactionsResponse.sourceAccount`: the closing account's signers and thresholds as read at
  the start of that round, the read its transactions were built from. A transaction can remove
  signers and lower thresholds, so judge signing weight against it, with each confirmed
  `SetOptions` of the round applied on top, rather than against an earlier read.
- Error code `close_fee_balance_short` (422) and the same plan blocker: the account lacks the XLM
  above its reserve to pay the fees of the steps no sponsor can cover (Soroban rounds, the exchange
  merge, and any transaction the sponsor would not accept or when no sponsor is configured). It is
  raised before such a round is built, and the message states how much XLM to add.
- `AccountState.numSponsored`: the reserves another account pays for this one. It lowers the
  minimum balance used to judge fees.
- `CloseDidNotConvergeError`, thrown by `runClose` instead of a bare `Error` when a close cannot
  finish. It carries `rounds`, `bound` and `reason` (`round_limit` or `empty_batch`).
- Error code `claimable_balance_not_claimable_now` (422): a balance answered `claim` or
  `add_trustline_then_claim` can no longer be claimed in this close because its claim window has
  closed or has not opened. Plan again.
- Error code `claimable_balance_reserve_short` (422) and the same plan blocker: the account lacks the
  XLM above its reserve to add the trustlines a claim needs, and the message states the shortfall.
  An unanswered balance of that kind is no longer offered `add_trustline_then_claim`; its decision
  carries only `forfeit` with the shortfall in the note. Several balances of one asset need one
  new reserve.
- Error code `claimable_balances_too_many` (422) and the same plan blocker: the account holds more
  claimable balances than one read returns and the ones left unclaimed fill it, so the rest cannot
  be reached and the account is not closed.
- Optional decision `claim_bulk:forfeit_unclaimable` (type `choice`, never required), offered when
  two or more balances cannot be claimed now. Answering `forfeit_unclaimable` forfeits every such
  balance that has no answer of its own; it never touches a balance claimable now.
- Claimable-balance decision `subject.claimableFromEpoch`: when a balance is claimable later, the
  epoch seconds from which it can be claimed, otherwise null.

### Changed

- `getAccount`, `getPaths`, `getAllowances`, `revokeAllowance`, `mediatorCheck`, `mediatorSign`
  and `feeBumpSponsor` call their `/v1/{network}/...` paths. The SDK no longer calls any legacy
  unversioned path; those answer with `Deprecation` and `Sunset` headers until 2027-06-01.
  Request bodies and headers are unchanged. The network segment is percent-encoded after it is
  checked.
- `runClose` resolves with `{ mergeConfirmed }` instead of `undefined`. It is true only with
  `reconcile`, for a transaction the client parsed as a merge and saw confirmed under its own hash.
  Without `reconcile` it is always false: a caller must establish the merge itself, because `covers`
  is API metadata.
- `submit_rejected` is `422` instead of `502`, and `mediator_key_misconfiguration` is `503` instead
  of `500`. `isApiErrorCode` is unaffected; anything branching on the status is not.
- `confirmation_timeout` arrives within about 35 seconds rather than 90 and carries `details` with
  `status: "pending"` and the `hash`. It stays an error on purpose: a client that reads `hash` from
  a success must never count a pending transaction as confirmed.
- `submit_failed` carries `details.hash` once the API has tried to send.
- `mediatorSign` and `feeBumpSponsor` now refuse an envelope that does not expire within 330
  seconds. Envelopes from `close/transactions` already do; an integration that builds its own
  must set a time bound.
- Fee affordability counts the XLM held by open offers selling XLM as unavailable, as the network
  does, so a transaction that would otherwise be rejected for insufficient balance is flagged
  `needsSponsoredFee` instead.
- A transaction is flagged `needsSponsoredFee` only when the fee sponsor is configured and would
  accept its operations; otherwise the build is refused with `close_fee_balance_short`.
- The trustline reserve shortfall for a claim counts the claim round's fees as the account's own,
  since no sponsor pays for a round that opens a trustline.
- Declarations are now emitted by the TypeScript 6 compiler, so an optional parameter typed
  `unknown` (the `reason` of `CloseDidNotConvergeError`) is written `unknown` instead of
  `unknown | undefined`. The two are the same type, and no runtime code changed.
- `runClose` derives its round bound from the API's `remaining.steps` (rounds done, plus steps
  left, plus a margin of 5), recomputed every round and capped at 200, instead of a fixed 25. An
  explicit `maxRounds` still overrides it. A close with many claimable balances or token transfers
  no longer stops early.
- `runClose` stops on the first response that asks for another call but carries no transactions.
- `close/transactions` refuses (422 `claimable_balance_not_claimable_now`) instead of building the
  merge when a claimable balance still on-chain is neither answered `forfeit` nor part of the claim
  round: an answer that does not fit what the account can do with it (`claim` for a balance that
  needs a trustline, `add_trustline_then_claim` for one that does not), a balance that closed since
  the plan, or one with no answer. The bulk forfeit is not offered or applied while the ledger time
  is unknown.

- Accounts with many claimable balances close in batches. The read returns up to 1500 balances
  (it used to refuse above 1000), each claim round claims at most 100 and reports
  `requiresAnotherCall`, and the merge is only built once a read finds nothing left to claim and
  nothing beyond the read.

- A claimable balance whose own claim predicate is false at the ledger close time (an expired
  `abs_before`, a future `not(before)`, an expired `rel_before`) is no longer defaulted to `claim`.
  Its decision offers only `forfeit` with no default and states the date from which it becomes
  claimable, and it is left out of the claim round. A predicate that is about to expire within the
  transaction window counts as closed. If the ledger time cannot be read, only unconditional
  claims count as claimable.

### Fixed

- Every client method that takes a network rejects with the new `LumenWipeInvalidNetworkError`,
  with no request made, when the network is not `"mainnet"` or `"testnet"`. This includes a
  `network` client option and an empty string, which used to fall back to the default network.

## [0.8.0] - 2026-10-12

### Added

- Plan blocker and error code `route_lookup_unavailable` (retryable): the swap route lookup failed,
  so the asset was not classified. It is distinct from an asset with no route. `close/transactions`
  reports a failed lookup as 503 `service_unavailable`, and `quote_drifted` only when the route
  was confirmed gone.
- Asset decision `subject.reason`: `dust_below_minimum` when a market exists but the balance would
  receive nothing once slippage is applied. It is absent for an asset with no market.

### Changed

- Asset decision points no longer carry `default: "return_to_issuer"`. An asset with no swap route,
  or a balance too small to swap, has an empty `default` and needs an explicit answer; an
  unanswered decision is refused with `needs_decisions`. A convertible asset still defaults to
  `convert_to_xlm`. Returning an asset to its issuer is never recommended or applied automatically.
  A caller that echoed `default` back as its answer for an asset with no route is now asked for a
  decision.
- A price source answer that is not a well-formed list of routes, and a rejected lookup, is a
  failed lookup rather than "no route".

## [0.7.0] - 2026-10-12

### Added

- Closing an account that issued assets still held by other accounts now needs an explicit
  acknowledgement. `close/plan` returns a `confirmation` decision point with id
  `issuer_supply:<address>` and the counts in its `subject`, plus a plan blocker with the code
  `issuer_supply_not_acknowledged` until it is answered with the choice
  `stranding_holders_acknowledged`. `close/transactions` refuses with the same error code (422)
  without the answer.
- Error code `issuer_read_failed` (503, retry): the account's issued assets could not be read.
  It is never reported as "issues nothing".

## [0.6.0] - 2026-10-12

### Added

- `Trustline` gains `authorization` (`"authorized" | "maintain_liabilities" | "unauthorized"`) and
  `clawbackEnabled`. `authorized` stays and is true only when `authorization` is `"authorized"`.
  Asset decision points carry both on their `subject` when the account holds the trustline.
- Error code `trustline_maintain_liabilities_with_balance`, also the `code` of the plan blocker for
  a line its issuer limited to keeping existing offers, which holds a balance.

### Changed

- The plan blocker for an unauthorized line holding a balance now carries the stable `code`
  `trustline_deauthorized_with_balance` instead of the generic `plan_blocker`. Its message is
  unchanged.
- An account read whose credit balances omit `is_authorized` (or `is_authorized_to_maintain_liabilities`
  on a line that is not authorized) now fails with the retryable `provider_response_unusable`
  instead of reading as authorized. `close/transactions` reports it as 502 `provider_response_unusable`
  rather than a 500 `transactions_failed`.

## [0.5.1] - 2026-10-10

### Added

- `StructuredApiError.error` gains an optional `requestId`: every API error body now carries the
  id of the request, the same value as the `x-request-id` response header that
  `LumenWipeApiError.requestId` already reads. Quote it when reporting a problem. Purely additive.

## [0.5.0] - 2026-10-10

### Changed

- **Breaking:** `PlanResponse.execution.estimatedTransactionCount` is now `number | null`. It is
  counted with the splitter the builder packs transactions with, so it is no longer always `1`:
  an exchange destination, claimable balances, Soroban token moves and a close over 100
  operations each add transactions, and `execution.transactions` lists them with the plan steps
  each `covers`. It is `null`, with `transactions` empty, when the count cannot be known yet: a
  DeFi exit in the plan, a held token with no decision, or no destination. Anyone who reads the
  field as a number (arithmetic, `toFixed`, a `number` annotation, displaying it) must handle
  `null` first and must not show an unknown count as a figure.

## [0.4.2] - 2026-10-10

### Added

- `ErrorCode` gains `merge_destination_unusable`, `source_sequence_too_far` and
  `destination_read_failed`: a close whose merge destination is the closing account, a LumenWipe
  service account or an unfunded account, or whose source sequence number is beyond what the
  network accepts, is now refused with a 422 before any transaction is built; an unreadable
  destination is a retryable 503. Purely additive.

## [0.4.1] - 2026-10-10

### Added

- `MediatorCheckResult.registryFresh`: whether the exchange registry is inside its verification
  window, so a client learns of staleness before an exchange close is refused.

## [0.4.0] - 2026-10-10

### Removed

- **Breaking:** the deprecated `PlainApiError` type, and with it the `ApiErrorBody` union member.
  `ApiErrorBody` is now just `StructuredApiError`; every API error already used that envelope.

### Added

- `LumenWipeApiError` now exposes `code`, `details`, `retryAfterMs` (from `Retry-After`) and
  `requestId` (from `X-Request-Id`, when the API sends one) next to `status` and `body`, and its
  message reads `LumenWipe API error 422 destination_not_acknowledged: <message>`. A non-JSON
  upstream failure has `code: "upstream_error"`.
- `isApiErrorCode(error, code)` type guard and the `ApiErrorCode` type.
- Every client method takes a trailing `{ signal }`. A caller abort rejects with the new
  `LumenWipeAbortError`, distinct from `LumenWipeTimeoutError`.
- Opt-in `retry: { attempts, baseDelayMs }` client option, honoring `Retry-After`. Off by default;
  `submit` and `mediatorSign` are never retried.
- Every request sends `X-LumenWipe-SDK: sdk/<version>`.
- The client logs once when a call falls back to the `"testnet"` default network, and once when
  `baseUrl` is plaintext `http://` on a non-local host. Pass `network`, or a `logger`, to control
  both; `logger` replaces the default `console.warn`.

- `ErrorCode`, the closed union of every `error.code` the API can return. Purely additive;
  `StructuredApiError.error.code` stays a `string` for now.
- `StatsTotals`, `StatsFeed`, `MergeRecord`, `DailyActivity` and `RecordMergeResponse` types,
  matching the API's new public close counter: `GET /v1/:network/stats`,
  `GET /v1/:network/stats/feed` and `POST /v1/:network/stats/merges`. Purely additive; no existing
  field changed shape.
- `DefiProtocol` gains `"xbull"`: xBull Swap is now a second, mainnet-only conversion-quote
  source alongside Soroswap for the Soroban-token-to-XLM step of a close. `DecisionAnswer.params`
  gains an optional `provider?: "soroswap" | "xbull"`, pinning which provider's quote a
  `convert_to_xlm` answer was accepted from. Both are purely additive; no existing field changed
  shape.
- `BatchPlanResult` and `BatchPlanResponse` types, matching the API's new
  `POST /v1/:network/close/batch-plan` endpoint: plans a bounded list of addresses in one call,
  isolating any address that can't be read or planned safely as its own blocked result rather
  than failing the whole batch. Purely additive; no existing field changed shape.
- A headless example, `examples/headless-close.ts`, that closes a testnet account driven entirely
  through the SDK with no web UI, verifying each transaction before signing it
  (`examples/verify.ts`). Linked from the README; not part of the published package.

## [0.2.0] - 2026-09-23

### Added

- `LumenWipeClient.feeBumpSponsor()`: wraps a wind-down transaction in a signed CAP-15 fee-bump
  envelope for an account that can't pay its own fee.
- `LumenWipeClient.getAllowances()`: every live SEP-41 allowance the account has granted -
  independent of closing an account, a standalone security utility.
- `LumenWipeClient.revokeAllowance()`: builds the unsigned `approve(owner, spender, 0, 0)`
  transaction that revokes one allowance.
- `coversTargets` on a `closeTransactions` step/transaction: which step types a transaction
  confirms, for cases where one transaction covers more than one step of the same type. Additive
  and optional - absent, every step of the named types is confirmed exactly as before.

## [0.1.0] - 2026-09-07

Initial public release. `LumenWipeClient` at this point covered the core close flow only - the
fee-bump/allowance endpoints above weren't added until after this tag.

### Added

- `LumenWipeClient`: typed fetch client for `health`, `getAccount`, `getPaths`, `closePlan`,
  `closeTransactions`, `submit`, `mediatorCheck`, and `mediatorSign`.
- `runClose`: pure, dependency-injected multi-round close runner (verify -> sign -> submit,
  looping until the account is closed), with `InsufficientSignatureWeightError` for resuming a
  partially-signed transaction once more signing weight is available.
- Dual ESM + CJS build with bundled type declarations (`@lumenwipe/types` rolled into the SDK's
  own `dist/index.d.ts` via `api-extractor` - no separate type-only dependency to install).
- Configurable timeout and custom `fetch` injection, for non-browser/non-Node environments and
  testing.

[0.2.0]: https://github.com/LumenWipe/lumenwipe/releases/tag/sdk-v0.2.0
[0.1.0]: https://github.com/LumenWipe/lumenwipe/releases/tag/sdk-v0.1.0
