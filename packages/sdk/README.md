# @lumenwipe/sdk

Typed fetch client for the [LumenWipe](https://lumenwipe.com) API. LumenWipe closes Stellar
accounts non-custodially: it unwinds everything holding an account open, converts leftovers to
XLM, and merges the account into a destination wallet or exchange.

This package only talks to the LumenWipe API over HTTP - it builds no transactions itself and has
no `@stellar/stellar-sdk` dependency. Reading on-chain state and constructing every unsigned
transaction happens server-side; this client just relays typed JSON and XDR strings.

## Install

```bash
npm install @lumenwipe/sdk
```

## Quick start

```ts
import { LumenWipeClient } from "@lumenwipe/sdk";

const client = new LumenWipeClient({
  baseUrl: "https://api.lumenwipe.com",
  apiKey: process.env.LUMENWIPE_API_KEY!,
  network: "mainnet", // or "testnet"
});

const account = await client.getAccount(address);

const plan = await client.closePlan({
  address,
  destination,
  // ...see @lumenwipe/types for the full request shape
});

const { transactions, remaining } = await client.closeTransactions({
  address,
  destination,
});

// Sign and submit each transaction, then repeat while remaining.requiresAnotherCall is true.
const result = await client.submit(signedXdr);
```

For a fully driven close loop (fetch -> verify -> sign -> submit -> repeat), use `runClose`
instead of calling `closeTransactions`/`submit` by hand:

```ts
import { runClose } from "@lumenwipe/sdk";

await runClose({
  getTransactions: () => client.closeTransactions({ address, destination }),
  verify: (tx) => myVerify(tx), // see "Verification" below - this is your responsibility
  requiredWeight: (tx) => myRequiredWeight(tx),
  sign: (tx, xdr) => mySigner(tx, xdr),
  submit: (tx, xdr) => client.submit(xdr).then((r) => r.hash),
});
```

## Verification is the caller's responsibility

This SDK does not verify or sign anything. Every transaction it returns is unsigned XDR built by
the API from data you provided - before signing, your own code must independently confirm the
transaction does exactly what the user asked (correct destination, no unexpected operations, no
added signers, matching amounts) using values from your own inputs, never from the API response
alone. LumenWipe's own web client's verification logic (`assertCloseIntent` in
[`apps/web/lib/stellar/verify.ts`](https://github.com/LumenWipe/lumenwipe/blob/main/apps/web/lib/stellar/verify.ts))
is the reference implementation - read it before wiring up signing in a production integration.
Never sign a transaction from this SDK without an equivalent check.

## API surface

- `health()` - service health check.
- `getAccount(address, network?)` - current on-chain state for an account.
- `getPaths(params, network?)` - conversion path quotes for a source asset.
- `closePlan(body, network?)` - a preview of the full close plan, with blockers if any step
  cannot be closed safely.
- `closeTransactions(body, network?)` - builds the next round of unsigned transactions.
- `submit(signedXdr, network?)` - submits a signed transaction.
- `mediatorCheck(address, network?)` / `mediatorSign(transaction, network?)` - the exchange
  mediator flow (see the architecture doc).
- `runClose(deps)` - drives the full fetch/verify/sign/submit loop to completion.

Request and response types come from `@lumenwipe/types` and are re-exported from this package, so
no separate install is needed.

## Errors

- `LumenWipeApiError` - thrown on any non-2xx API response; carries `status` and the parsed
  error `body`.
- `LumenWipeTimeoutError` - thrown when a request exceeds the configured `timeout`
  (default 30s).

## Links

- [Architecture](https://github.com/LumenWipe/lumenwipe/blob/main/docs/architecture.md)
- [Full documentation](https://docs.lumenwipe.com)
- [Issues](https://github.com/LumenWipe/lumenwipe/issues)

## License

Apache-2.0
