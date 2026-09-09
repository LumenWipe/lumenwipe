# Changelog

All notable changes to `@lumenwipe/sdk` are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[Semantic Versioning](https://semver.org/). See [`RELEASING.md`](../../RELEASING.md) for how a
release is cut.

## [0.1.0] - 2026-09-07

Initial public release.

### Added

- `LumenWipeClient`: typed fetch client for the full close flow - `getAccount`, `closePlan`,
  `closeTransactions`, `submit`, and the mediator/fee-bump/allowance endpoints.
- `runClose`: pure, dependency-injected multi-round close runner (verify -> sign -> submit,
  looping until the account is closed), with `InsufficientSignatureWeightError` for resuming a
  partially-signed transaction once more signing weight is available.
- Dual ESM + CJS build with bundled type declarations (`@lumenwipe/types` rolled into the SDK's
  own `dist/index.d.ts` via `api-extractor` - no separate type-only dependency to install).
- Configurable timeout and custom `fetch` injection, for non-browser/non-Node environments and
  testing.

[0.1.0]: https://github.com/LumenWipe/lumenwipe/releases/tag/sdk-v0.1.0
