# Changelog

All notable changes to `@lumenwipe/sdk` are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[Semantic Versioning](https://semver.org/). See [`RELEASING.md`](../../RELEASING.md) for how a
release is cut.

## [Unreleased]

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
