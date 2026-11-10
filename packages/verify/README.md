# @lumenwipe/verify

The verifier the LumenWipe web app runs before every signature, as a package. It decodes an
API-built, unsigned close transaction and asserts it does exactly what the user asked; it throws
`VerificationError` on any mismatch, and you sign only after it returns.

It is not a port. The bundle is compiled from the web's own
[`apps/web/lib/stellar/verify.ts`](https://github.com/LumenWipe/lumenwipe/blob/main/apps/web/lib/stellar/verify.ts),
`exit-expectations.ts` and `verification-error.ts`, so there is one implementation. A shared
conformance vector set (`vectors/close-v1.json`) runs against this package and against the web
verifier in CI.

It also ships the web's trust anchor for an allowance revocation,
`verifyRevokeAllowanceTransaction`, compiled from
[`verify-revoke-allowance.ts`](https://github.com/LumenWipe/lumenwipe/blob/main/apps/web/lib/stellar/verify-revoke-allowance.ts)
with its own vector set (`vectors/revoke-allowance-v1.json`).

## Install

```bash
npm install @lumenwipe/verify @stellar/stellar-sdk@17.4.0
```

`@stellar/stellar-sdk` is a peer dependency and is never bundled. The peer is pinned to the exact
version the web verifier is tested with.

## Usage with `runClose`

```ts
import { LumenWipeClient, runClose } from "@lumenwipe/sdk";
import { exitExpectations, verifyCloseTransaction } from "@lumenwipe/verify";

const account = await client.getAccount(source); // the read the user reviewed
const servedRegistry = await client.getExchangeRegistry(); // optional, see below

await runClose({
  // ...getTransactions, requiredWeight, sign, submit
  verify: (tx) =>
    verifyCloseTransaction({
      unsignedXdr: tx.xdr,
      network: "testnet",
      expected: {
        source,
        destination, // typed by the user
        nativeBalance: account.nativeBalanceLumens,
        memo: null, // the memo the user confirmed
        memoType: null,
        claimTrustlineAssets: [],
        accountSigners: account.signers,
        accountThresholds: account.thresholds,
        transfers: {}, // per-asset choices the user made
        tokenTransfers: {},
        classicConversions: {},
        tokenConversions: {},
        ...exitExpectations(account, "testnet"),
      },
      servedRegistry,
    }),
});
```

## Where each input comes from

Never from the transaction under verification, and never from the API's `intent` summary.

| Input                                                                   | Source                                                                                                             |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `destination`, `memo`, `memoType`                                       | What the user typed and confirmed.                                                                                 |
| `transfers`, `tokenTransfers`, `classicConversions`, `tokenConversions` | The user's per-asset choices, with the balances and quotes they were shown as floors. Pass `{}` for none.          |
| `claimTrustlineAssets`                                                  | The `CODE:ISSUER` of each claimable balance the user chose to claim.                                               |
| `source`, `nativeBalance`, `accountSigners`, `accountThresholds`        | The account read the user reviewed (`client.getAccount`, or a round's `sourceAccount`). Empty signers fail closed. |
| The DeFi fields (`exitContracts` and the rest)                          | `exitExpectations(account, network)`: the same read plus the contract registry bundled here.                       |

Whether a destination is a listed exchange, whether it needs a memo and of which type, and
whether the merge must go through the shared intermediary are not inputs. The verifier derives
them from the exchange registry bundled in this package, tightened by `servedRegistry` when you
pass one.

`requiresMediator(address)` exposes that same decision. An exchange close is one transaction
holding the merge into the intermediary and the intermediary's forward, which the API co-signs
(`mediatorSign`). Decide whether to ask for that co-signature with `requiresMediator(destination)`
on the address the user typed, never from the API's response.

## The bundled registries

This package bundles the exchange and contract registries as of its release, and it reads no
network at all. A new version is released on every registry change.

### A served exchange registry snapshot

`verifyCloseTransaction` takes an optional `servedRegistry`: the body of
`GET /v1/config/exchange-registry` (`client.getExchangeRegistry()`), fetched by you and passed
as is. It is merged over the bundled exchange registry with the same stricter-only rule the web
app applies to the copy it is served. The snapshot is not authenticated; it is safe to pass
because it can only make verification stricter:

- A bundled exchange is never removed, and its memo requirement and its refusal of a direct
  merge are never turned off.
- An address the snapshot adds is checked as an exchange: a direct merge into it is refused if it
  needs the intermediary, a memo is required if it needs one, and a transfer to it is refused.
- It never enables the mediated hand-off: that stays limited to the exchanges bundled here
  (`requiresMediator`, which takes no snapshot). An address only the snapshot lists as needing the
  intermediary refuses both a direct merge and the hand-off until you upgrade. Accepting the
  hand-off on served data would let the API, which also builds the transaction and reports the
  balance the forward is checked against, choose which closes go through an intermediary.
- Its `validUntil` may move the bundled expiry later, by at most 120 days, and never earlier.
- An entry that is not well formed is dropped. A snapshot that is not a registry at all (no
  `entries` list, or no `lastVerified` or `validUntil` string) is refused with
  `registry_snapshot_invalid` rather than ignored.

- It never decides a memo type, because a memo sent under the wrong type reaches the exchange
  and is credited to nobody. A bundled exchange it lists with a different `memoType` refuses the
  close with `registry_memo_type_conflict` until you upgrade. For an address only the snapshot
  lists, the type the user confirmed is the one checked, and a snapshot type that differs from
  it refuses the close with `registry_memo_type_unconfirmed`.

An entry's `name` is taken from it, as in the web app, and used only in refusal messages.

Without a snapshot:

- an exchange added to the registry after this release is treated as a plain wallet, and a
  close to it is accepted only as a direct merge with the memo the user typed;
- once the bundled exchange registry's `validUntil` passes, every close to a listed exchange is
  refused until you upgrade.

`verifyCloseTransaction` also reads the system clock for the transaction's expiry: a transaction
valid for more than 900 seconds from now is refused.

## Revoking an allowance

`verifyRevokeAllowanceTransaction` checks an API-built revocation before the signature: exactly
one `approve(owner, spender, 0, expiration)` on the token, sourced from the owner, with no memo,
a fee of at most 10,000,000 stroops, valid for at most 900 seconds, authorized only by the
owner's own source account and naming no other account or contract. Pass the allowance your
screen showed, never values read from the transaction:

```ts
import {
  RevokeAllowanceVerificationError,
  verifyRevokeAllowanceTransaction,
} from "@lumenwipe/verify";
import { Networks } from "@stellar/stellar-sdk";

try {
  verifyRevokeAllowanceTransaction(unsignedXdr, Networks.PUBLIC, { owner, token, spender });
} catch (error) {
  if (error instanceof RevokeAllowanceVerificationError) console.error(error.code);
  throw error;
}
```

It throws `RevokeAllowanceVerificationError` with a stable `code`
(`RevokeAllowanceVerificationErrorCode`), or `VerificationError` when the envelope cannot be
decoded at all. The optional fourth argument is the current Unix time in seconds; it defaults to
the system clock.

## Conformance vectors

`vectors/close-v1.json` (schema 1) lists accepted and rejected transactions with the full
`VerifyCloseInput` for each, the clock to set (`nowSeconds`), and for a rejection the
`VerificationError` code and exact message; match on the code, which is stable across releases. Each rejection is one named mutation of an accepted vector: its transaction, its `servedRegistry` snapshot, or both. Pass `input.servedRegistry` along when a vector has one. Every
key in it is public; no secret is stored. Use it to test your own verifier, or a wrapper around
this one:

```ts
import vectors from "@lumenwipe/verify/vectors/close-v1.json" with { type: "json" };
```

`vectors/revoke-allowance-v1.json` (schema 1) does the same for
`verifyRevokeAllowanceTransaction`: each vector gives the envelope, the network passphrase, the
expectation and `nowSeconds` to pass as the fourth argument, and for a rejection the error
`class`, `code` and exact `message`.

## License

Apache-2.0
