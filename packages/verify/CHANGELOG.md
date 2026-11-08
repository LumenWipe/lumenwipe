# Changelog

All notable changes to `@lumenwipe/verify` are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[Semantic Versioning](https://semver.org/). See [`RELEASING.md`](../../RELEASING.md) for how a
release is cut.

## [Unreleased]

## [0.2.0] - 2026-11-08

### Added

- Three vectors in `vectors/close-v1.json` for a multisig close's first transaction, signer
  normalization with no merge: `multisig-normalization-first`, accepted, and its rejected
  mutations `normalization-first-threshold-raised` and `normalization-first-signer-added`.
- Two `VerificationErrorCode` values: `registry_memo_type_conflict` and
  `registry_memo_type_unconfirmed`.
- Vectors for a snapshot that changes a memo type: `exchange-close-with-numeric-text-memo`,
  accepted, its rejected mutations `snapshot-changes-exchange-memo-type` and
  `snapshot-disputes-exchange-memo-type`, and
  `snapshot-memo-type-other-than-confirmed`, a rejected mutation of
  `close-to-exchange-listed-by-snapshot`.

### Changed

- A served registry snapshot no longer decides a memo type. A bundled exchange the snapshot
  lists with a different `memoType` is refused with `registry_memo_type_conflict`, where the
  snapshot's type used to be adopted. For an address only the snapshot lists, the type the user
  confirmed is checked, and a snapshot type that differs from it is refused with
  `registry_memo_type_unconfirmed`, where it used to replace the confirmed type. A memo with
  no readable confirmed type to such an address is refused with `memo_type_unreadable`, where
  the snapshot's type used to be filled in.
- The vector `close-to-exchange-listed-by-snapshot` now confirms an id memo, the snapshot's
  type, instead of text, and the description of its mutation `memo-type-other-than-snapshot`
  says so. Its code and message are unchanged.

## [0.1.0] - 2026-11-08

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

[Unreleased]: https://github.com/LumenWipe/lumenwipe/compare/verify-v0.2.0...HEAD
[0.2.0]: https://github.com/LumenWipe/lumenwipe/compare/verify-v0.1.0...verify-v0.2.0
[0.1.0]: https://github.com/LumenWipe/lumenwipe/tree/verify-v0.1.0
