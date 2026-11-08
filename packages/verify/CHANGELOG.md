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
- `VerificationError`, and the documented input types `VerifyCloseInput`,
  `CloseExpectationInput` and `ExitExpectations`.
- `vectors/close-v1.json`, the conformance vector set (schema 1).
