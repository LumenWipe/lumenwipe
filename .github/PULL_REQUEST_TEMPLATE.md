Closes #

## Summary

What this changes and why.

## Security-sensitive changes

Delete this section if not applicable. Per CONTRIBUTING.md §7: key handling, transaction
construction, `verify()`, confirmation flows, the mediator flow, and CSP changes require extra
description here and get closer review.

## Protocol exit invariants

Delete this section if not applicable. For a new or changed DeFi exit adapter, state which
invariants in [docs/architecture.md §9.9](docs/architecture.md#99-exit-adapter-invariants) apply
and how this PR satisfies each one.

## Test plan

- [ ] `bun type-check` - passes
- [ ] `bun lint` - passes
- [ ] `bun test` - passes, note any new test files/counts
- [ ] `bun test:e2e` (if UI-facing or a new protocol integration) - passes against testnet
- [ ] Manual verification (describe what you did, or state why automated coverage above is
      sufficient on its own)

## Risk / edge cases

Anything a reviewer should pay close attention to - the parts of this diff most likely to be wrong
in a way tests wouldn't catch.

## Follow-ups

Optional - anything intentionally deferred, noted here for visibility rather than left silent.
