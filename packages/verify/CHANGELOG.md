# Changelog

All notable changes to `@lumenwipe/verify` are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[Semantic Versioning](https://semver.org/). See [`RELEASING.md`](../../RELEASING.md) for how a
release is cut.

## [0.1.0] - Unreleased

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
