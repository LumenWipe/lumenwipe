# Changelog

All notable changes to `@lumenwipe/sdk` are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[Semantic Versioning](https://semver.org/). See [`RELEASING.md`](../../RELEASING.md) for how a
release is cut.

## [Unreleased]

Landed on `main` since the last tagged release - not on npm yet. This is exactly the drift
[`RELEASING.md`](../../RELEASING.md) and CI's `sdk-version-bump` check exist to surface: move
these into a new dated section (and bump `package.json`) the next time `packages/sdk` is released.

### Added

- `LumenWipeClient.feeBumpSponsor()`: wraps a wind-down transaction in a signed CAP-15 fee-bump
  envelope for an account that can't pay its own fee.
- `LumenWipeClient.getAllowances()`: every live SEP-41 allowance the account has granted -
  independent of closing an account, a standalone security utility.
- `LumenWipeClient.revokeAllowance()`: builds the unsigned `approve(owner, spender, 0, 0)`
  transaction that revokes one allowance.

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

[0.1.0]: https://github.com/LumenWipe/lumenwipe/releases/tag/sdk-v0.1.0
