# Changelog

All notable changes to `@lumenwipe/verify` are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[Semantic Versioning](https://semver.org/). See [`RELEASING.md`](../../RELEASING.md) for how a
release is cut.

## [Unreleased]

Not released yet; the first release will be 0.1.0.

### Added

- `verifyCloseTransaction(input)`, compiled from the web verifier, with the bundled exchange and
  contract registries.
- `exitExpectations(accountState, network)`, the DeFi half of the expectation.
- `requiresMediator(address)`, whether a close to that address goes through the shared
  intermediary according to the bundled exchange registry.
- `VerificationError`, and the documented input types `VerifyCloseInput`,
  `CloseExpectationInput` and `ExitExpectations`.
- `VerificationError.code`, one stable `VerificationErrorCode` per refusal reason, alongside the
  message. Branch on the code: the message is English wording and may change. The constructor
  takes the code first, `new VerificationError(code, message)`.
- `vectors/close-v1.json`, the conformance vector set (schema 1).
- Each rejection in `vectors/close-v1.json` carries `error.code` next to `error.message`.
- `VerifyCloseInput.servedRegistry`, an optional served exchange registry snapshot (type
  `ServedRegistry`, the body of `GET /v1/config/exchange-registry`) merged over the bundled
  registry with the web app's stricter-only rule. It can refuse a direct merge, require a memo
  and its type, refuse a transfer to a deposit address, and move the registry's validity later
  by at most 120 days. It never enables the mediated hand-off, and `requiresMediator` is
  unchanged. A snapshot that is not a registry is refused with the new code
  `registry_snapshot_invalid`.
- Vectors for a served snapshot in `vectors/close-v1.json`, still schema 1: `input.servedRegistry`
  is optional, and a rejection may mutate the snapshot instead of, or with, the transaction.
- The package ships its `LICENSE` and this `CHANGELOG.md`.
