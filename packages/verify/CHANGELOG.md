# Changelog

All notable changes to `@lumenwipe/verify` are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[Semantic Versioning](https://semver.org/). See [`RELEASING.md`](../../RELEASING.md) for how a
release is cut.

## [Unreleased]

### Changed

- `verify()` accepts a Soroswap aggregator `swap_exact_in` whose `partner` is a 0-bps partner,
  `{ bps: 0, id }`, a shape 0.7.0 refused. Since the aggregator's 2026-11-23 upgrade the Soroswap
  API names one on every swap it builds for an API key. At 0 bps the partner only labels the swap:
  the aggregator charges its own 10 bps fee, as with no partner, and pays no partner. Any other bps,
  a key out of order, a missing or extra key, or a bps that is not the number 0 is still refused
  with `swap_args_unreadable`, and the id is trusted for nothing. A new accepted mainnet vector
  converts a token through the aggregator with a 0-bps partner, with rejected mutations at 1, 25
  and 100 bps and with a third key in the partner. The next release is a minor: it accepts a shape
  the previous one refused, and RELEASING.md bumps the minor for a new capability before 1.0.

## [0.7.0] - 2026-11-23

### Added

- The `mediator_forward_balance_unknown` verification code.
- Classic liquidity pool withdrawals. `verify()` accepts a `liquidityPoolWithdraw` only for a pool
  in the new optional `poolWithdrawals` expectation, for exactly the shares held, with each
  minimum at least 98% and at most 101% of what the expected reserves give (exactly 0 for a side
  they give nothing of). A pool share trustline removal is accepted only for one of those pools,
  with the pool id derived from the asset pair and fee the operation carries. Without
  `poolWithdrawals` both are refused. Build it with the new `poolWithdrawalExpectations` from the
  account read. New codes: `pool_not_held`, `pool_withdraw_duplicate`,
  `pool_withdraw_amount_mismatch`, `pool_withdraw_min_missing`, `pool_withdraw_min_below_floor`,
  `pool_withdraw_min_above_reserves` and `pool_line_mismatch`. A new accepted vector withdraws
  from a pool, with rejected mutations for a swapped pool, a changed share amount, a zero, a low
  and an inflated minimum, and the removal of another pool's share line.
- Sponsorship revokes of a liquidity pool share trustline, alongside every other kind (see
  Changed). A new accepted vector revokes one sponsorship of each kind before the merge: an
  account, an asset trustline, a pool share trustline, an offer, a data entry, and an ed25519, a
  pre-authorized transaction and a hash signer. Its rejected mutations name the same entry on
  another account and the same entry twice, for each kind, then another asset, pool, offer, data
  name and signer of the same account.
- `SponsoredEntry` is exported, the type of an account read's `sponsoredEntries`.

### Changed

- **Breaking:** `verify()` accepts a sponsorship revoke of any kind only for an entry in the new
  optional `sponsoredEntries` expectation, matched by kind, owner and key (the asset, the pool id,
  the offer id, the data name, the signer's strkey), at most once per transaction. Without
  `sponsoredEntries` every sponsorship revoke is refused, where 0.6.0 accepted every one. A data name that is not valid UTF-8 names no entry. New codes:
  `sponsorship_revoke_unknown` and `sponsorship_revoke_duplicate`. To migrate, pass the account
  read's list as is: `sponsoredEntries: account.sponsoredEntries`.
- `verify()` refuses the mediator hand-off when the observed native balance is not above the
  0.01 XLM tolerance (`mediator_forward_balance_unknown`). Below it the forward floor was zero or
  negative, so a check run with no balance read (`nativeBalance: "0"`) accepted any forward. A new
  accepted vector verifies a round ahead of the merge with no balance read, and its rejected
  mutation adds the hand-off to it.
- The bundled list of networks now comes from one module that the web app's routing also reads.
  The networks themselves (`mainnet`, `testnet`) and what `verify()` accepts are unchanged.
- The bundled contract registry (version `2026-11-23`) re-pins the mainnet Soroswap aggregator
  (`CARVQXFP4JF5ELLXUMQ6DALR346YVGBMQOHB4ENA7SSVXAYABXLBDDC4`) to the code it runs since its
  upstream upgrade on 2026-11-23. The previous code is no longer recognized. The aggregator's
  address, its `swap_exact_in` interface and the contracts a close may call are unchanged, and so
  is verification.

## [0.6.0] - 2026-11-19

### Added

- The `exit_arguments_unexpected` verification code.

### Changed

- `verify()` checks the arguments of a Phoenix `withdraw_liquidity`: the sender must be the
  account being closed (`exit_argument_party_mismatch`), and there must be exactly the six
  arguments every registered pool code takes, with integer amounts and the deadline and the
  `auto_unstake` argument unset (`exit_arguments_unexpected`). The real testnet Phoenix
  withdrawal vector is recaptured from the new testnet pool, so it is a six-argument call with a
  new envelope, source and share token, and three vectors mutate it: without `auto_unstake`, with
  an `auto_unstake`, and with another sender.
- The bundled contract registry lists two more mainnet Phoenix pools, both from the Phoenix
  factory's own pool list. PHO/USDC `CCPPPTDW…` runs a later build of the v2 pool code, and its
  stake contract `CBUS3GWD…` a build of the v2 stake code, so a withdrawal from that pool and an
  `unbond` on that stake now pass. XLM/USDC `CBENABXP…` runs Phoenix's blended pool code under a
  new version, `blended`. It has no stake contract of its own, so only its `withdraw_liquidity`
  passes, and an `unbond` on it is still refused.
- The bundled contract registry's testnet Phoenix pool and stake are replaced: pool `CA4V7YVU…`
  runs the mainnet v1 pool code and stake `CBYFZPJ2…` the mainnet v1 stake code, both version
  `v1`, in place of `CCVEHSVG…` and `CCELNFRX…`, whose older pool build took a five-argument
  `withdraw_liquidity`. The pool's tokens are a new test token `CBQP4F36…` and XLM, and its share
  token is `CDZPFQQU…`. A withdrawal or `unbond` on the old testnet contracts is now refused.

- The bundled exchange and contract registries are re-verified and restamped: `lastVerified`
  2026-11-17 and `validUntil` 2027-02-15. No entry is added, removed or re-pinned; contract
  entries record the day their live code was re-read. The two vectors that run past the bundled
  expiry now take their clock and snapshot dates from the bundled registry, so their
  `nowSeconds`, descriptions and dates move with it; their names and expected results are
  unchanged.
- The bundled contract registry's Phoenix stake entry `CDOXQONP…` records new evidence: its
  `unbond` pays the token under its `NEWLP` storage key, which is its pool's share token, so its
  `verifiedBy` and `verifiedAt` change. Its address, code hash and version are unchanged, and so
  is verification.

## [0.5.0] - 2026-11-17

### Added

- The bundled contract registry module gains `exitCapableProtocols(network)`, which names the
  protocols with at least one contract an exit may touch on that network, by the same rule the
  verifier applies. It is not exported from the package entry point, and verification is
  unchanged.
- The bundled contract registry module gains an internal export of the registry's
  `lastVerified` and `validUntil` dates, and the bundled exchange registry module splits its
  fetch-and-merge step out of the function that adopts the served copy. Neither is exported from
  the package entry point, and verification and the bundled registry are unchanged.

### Changed

- The bundled contract registry re-pins the Aquarius testnet router and its constant-product,
  stableswap and concentrated pool code after the upstream upgrade. The testnet pools now take
  their code from a CAP-85 external reference, so their entries record the owner contract and tag
  next to the hash, and the owner is registered as a new entry kind, `executable-owner`, which is
  never treated as a contract a close may call. On testnet, `exitExpectations` lists the same
  contract addresses as before. Mainnet entries are unchanged.
- The bundled contract registry (version `2026-11-16`) records each mainnet entry's provenance:
  how its hash was verified (`verifiedBy`), where its address is published (`source`) and the day
  it was last verified (`verifiedAt`). Testnet contracts LumenWipe deployed itself are marked
  `ownDeployment`. No address, hash, version or `verifiedLive` value changed, and the contracts a
  close may call, `validUntil` and verification are unchanged.
- The bundled contract registry (version `2026-11-17`) re-pins the mainnet xBull router
  (`CCKXBE5GKJOCE7IKL64HLYKW3IJSUPVOLC4CS77GQT5QQHDZLDYV3DFT`) to the code it runs since its
  upstream upgrade on 2026-11-16. The previous code is no longer recognized. The router's address,
  its `strict_send` interface and the contracts a close may call are unchanged, and so is
  verification.

## [0.4.0] - 2026-11-10

### Changed

- **Breaking:** `requiresMediator(address)` is now `requiresMediator(address, network)`. The
  network is required: a call without it is a type error, and the answer is for that network
  only. Pass the network the close runs on, the same value you pass `verifyCloseTransaction`.

### Added

- An exchange registry entry may carry `network: "testnet"` (`ExchangeRegistryEntry.network`).
  Such an entry applies on testnet only. On mainnet its address is not listed: `requiresMediator`
  answers false, and `verifyCloseTransaction` checks a close to it as a close to a plain wallet,
  so the mediated hand-off to it is refused. A served snapshot cannot change the network a
  bundled entry applies on, and an entry it adds with any other `network` value is dropped.
- The bundled exchange registry gains one testnet-only entry, "LumenWipe testnet exchange"
  (`GB4VXLVR2DDIJUPVVY74QVPEIHINBMMXO6WUY67JUEYO42LQSDS5IMKW`), which needs the intermediary and
  an id memo. The mainnet entries are unchanged.
- Three vectors in `vectors/close-v1.json`: `testnet-stand-in-close-through-intermediary`,
  accepted on testnet; `testnet-stand-in-is-a-wallet-on-mainnet`, accepted on mainnet; and its
  rejected mutation `testnet-stand-in-through-intermediary-on-mainnet`. These are the first
  vectors whose `input.network` is `mainnet`.

## [0.3.0] - 2026-11-10

### Added

- `verifyRevokeAllowanceTransaction(unsignedXdr, networkPassphrase, expected, nowSeconds?)`,
  compiled from the web's allowance-revocation trust anchor, with the documented input type
  `RevokeAllowanceExpectation` (`owner`, `token`, `spender`).
- `RevokeAllowanceVerificationError`, whose `name` is `"RevokeAllowanceVerificationError"` and
  whose `code` is one stable `RevokeAllowanceVerificationErrorCode` per refusal reason. Branch on
  the code: the message is English wording and may change. An envelope that cannot be decoded is
  refused with `VerificationError` and its existing code.
- `vectors/revoke-allowance-v1.json`, exported as `@lumenwipe/verify/vectors/revoke-allowance-v1.json`:
  two accepted revocations (a contract and an account spender) and a rejected mutation for every
  refusal code, plus one envelope the decoder refuses.

The bundled exchange and contract registries are unchanged.

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

[Unreleased]: https://github.com/LumenWipe/lumenwipe/compare/verify-v0.7.0...HEAD
[0.7.0]: https://github.com/LumenWipe/lumenwipe/compare/verify-v0.6.0...verify-v0.7.0
[0.6.0]: https://github.com/LumenWipe/lumenwipe/compare/verify-v0.5.0...verify-v0.6.0
[0.5.0]: https://github.com/LumenWipe/lumenwipe/compare/verify-v0.4.0...verify-v0.5.0
[0.4.0]: https://github.com/LumenWipe/lumenwipe/compare/verify-v0.3.0...verify-v0.4.0
[0.3.0]: https://github.com/LumenWipe/lumenwipe/compare/verify-v0.2.0...verify-v0.3.0
[0.2.0]: https://github.com/LumenWipe/lumenwipe/compare/verify-v0.1.0...verify-v0.2.0
[0.1.0]: https://github.com/LumenWipe/lumenwipe/tree/verify-v0.1.0
