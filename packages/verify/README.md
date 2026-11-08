# @lumenwipe/verify

The verifier the LumenWipe web app runs before every signature, as a package. It decodes an
API-built, unsigned close transaction and asserts it does exactly what the user asked; it throws
`VerificationError` on any mismatch, and you sign only after it returns.

It is not a port. The bundle is compiled from the web's own
[`apps/web/lib/stellar/verify.ts`](https://github.com/LumenWipe/lumenwipe/blob/main/apps/web/lib/stellar/verify.ts),
`exit-expectations.ts` and `verification-error.ts`, so there is one implementation. A shared
conformance vector set (`vectors/close-v1.json`) runs against this package and against the web
verifier in CI.

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
them from the exchange registry bundled in this package.

`requiresMediator(address)` exposes that same decision. An exchange close is one transaction
holding the merge into the intermediary and the intermediary's forward, which the API co-signs
(`mediatorSign`). Decide whether to ask for that co-signature with `requiresMediator(destination)`
on the address the user typed, never from the API's response.

## The bundled registries

This package uses only the exchange and contract registries bundled in it, as of its release.
It never fetches the registry the API serves, and it reads no network at all. The web app also
merges the API's served copy over its bundle (a served entry may only tighten a bundled one);
this package does not. So:

- an exchange added to the registry after this release is treated as a plain wallet, and a
  close to it is accepted only as a direct merge with the memo the user typed;
- once the bundled exchange registry's `validUntil` passes, every close to a listed exchange is
  refused until you upgrade. A new version is released on every registry change.

`verifyCloseTransaction` also reads the system clock for the transaction's expiry: a transaction
valid for more than 900 seconds from now is refused.

## Conformance vectors

`vectors/close-v1.json` (schema 1) lists accepted and rejected transactions with the full
`VerifyCloseInput` for each, the clock to set (`nowSeconds`), and for a rejection the
`VerificationError` code and exact message; match on the code, which is stable across releases. Each rejection is one named mutation of an accepted vector. Every
key in it is public; no secret is stored. Use it to test your own verifier, or a wrapper around
this one:

```ts
import vectors from "@lumenwipe/verify/vectors/close-v1.json" with { type: "json" };
```

## License

Apache-2.0
