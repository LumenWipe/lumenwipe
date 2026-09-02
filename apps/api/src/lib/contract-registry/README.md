# The versioned contract registry

`src/config/contract-registry.json` records the DeFi contracts LumenWipe knows: for each deployed
instance, its address, the protocol and version it belongs to, and the `wasmHash` (SHA-256 of the
deployed code) it was verified as running. See
[architecture.md](../../../../../docs/architecture.md) §9.

Two consumers read it:

- The testnet detection fallback probes the listed contracts for an account's positions and
  confirms each is still running its recorded hash.
- Exit adapters resolve a position's contract through `resolveWasmHash(network, hash)` before
  building anything. An unknown hash flags the position for manual review and **builds nothing**
  (§9.9). Resolution is scoped to the network an entry was verified on.

The registry is community-updated by pull request (§14). A protocol upgrade is a new entry here
plus an adapter change, never a rewrite (§18).

## Adding an entry

1. Fetch the contract's code hash from the ledger yourself - for example
   `stellar contract fetch --id C... --network testnet | sha256sum`, or read the contract instance
   over RPC `getLedgerEntries` and take the wasm hash from its executable. Never copy a hash from a
   forum post or another registry.
2. Add one object to `entries`:
   - `network`: `mainnet` or `testnet` - the one network you verified this instance on
   - `protocol`: one of `blend`, `aquarius`, `soroswap`, `phoenix`, `fxdao`
   - `kind`: `pool`, `pair`, `backstop`, `vault`, `factory`, or `router`. A `pair` entry is one
     representative factory-deployed pair: every pair the factory deploys shares its code hash, so
     one entry lets `resolveWasmHash` recognize all of them, and detection enumerates the pairs
     themselves from the factory rather than from this file
   - `address`: the deployed contract (`C...`, checksum-validated)
   - `wasmHash`: 64 lowercase hex characters. `null` is allowed only with `verifiedLive: false`,
     for a contract the protocol documents but that does not currently resolve on-chain
   - `version`: the protocol's own version name, e.g. `"v2"`
   - `label`: what this is, and any caveat (e.g. "reference only, not probed for balances")
   - `verifiedLive`: whether the address resolved on-chain when you checked
   - `verifiedBy` (optional, recommended): the exact command or explorer link from step 1, so a
     reviewer can re-run the verification
3. Run `bun test tests/unit/contract-registry.test.ts` from `apps/api`. The suite validates the
   shipped JSON on every run, so a malformed edit fails CI before it can ship.

One entry per pull request, with the verification evidence in the PR description.

## Refreshing it

The file carries `lastVerified` and `validUntil`, and `isRegistryFresh()` is fail-closed past
`validUntil`, the same convention as the exchange registry. Refreshing is bounded, manual work:
re-resolve every entry's address on its network, confirm the hash still matches, set
`lastVerified` to today and `validUntil` out again, and say in the PR what you checked.

## What reviewers hold the line on

- The hash was independently verified on-chain (re-run `verifiedBy`, or the command in step 1).
- Many instances may share one hash (every pool a factory deploys does), but one hash never maps
  to two different protocol versions - the validator rejects the contradiction, and a genuine
  collision needs a human decision, not a merge.
- Removing an entry is a breaking act: positions on that version stop resolving and start
  flagging for manual review. That can be correct (a compromised version) but never silent.
