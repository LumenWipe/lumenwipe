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

const account = await client.getAccount(source);

const plan = await client.closePlan({ source, destination });
if (plan.blockers.length > 0) throw new Error(plan.blockers.map((b) => b.message).join("; "));

// Every decision point needs an answer (convert or keep a token, acknowledge an exchange, ...).
// Show them to the user, plan again with the answers, and close with those same answers.
const decisions = await askUser(plan.decisionPoints);
const reviewed = await client.closePlan({ source, destination, decisions });

const { transactions, remaining } = await client.closeTransactions({
  source,
  destination,
  decisions,
  planHash: reviewed.planHash,
});

// Sign and submit each transaction, then repeat while remaining.requiresAnotherCall is true.
const result = await client.submit(signedXdr);
```

For a fully driven close loop (fetch -> verify -> sign -> submit -> repeat), use `runClose`
instead of calling `closeTransactions`/`submit` by hand:

```ts
import { runClose } from "@lumenwipe/sdk";

await runClose({
  getTransactions: () => client.closeTransactions({ source, destination }),
  verify: (tx) => myVerify(tx), // see "Verification" below - this is your responsibility
  requiredWeight: (tx) => myRequiredWeight(tx),
  sign: (tx, xdr) => mySigner(tx, xdr),
  submit: (tx, xdr) => client.submit(xdr).then((r) => r.hash),
});
```

### Progress

Pass `onProgressEvent` to follow the close, for example to show "Transaction 2 of 3: approve in
your wallet":

```ts
await runClose({
  ...deps,
  onProgressEvent: (event) => {
    if (event.phase === "preparing") return show(`Preparing round ${event.round + 1}…`);
    const of = event.moreRoundsExpected ? `at least ${event.txCount}` : `${event.txCount}`;
    show(`Transaction ${event.txIndex + 1} of ${of}: ${event.phase}`);
  },
});
```

- `phase`: `preparing` before each round is fetched; then, for each transaction, `verifying`,
  `awaiting-signature` (the signer, for example a wallet, has been asked), `submitting` (signed;
  the network is waited on) and `confirmed`. A resumed transaction starts at
  `awaiting-signature`.
- `round`: zero-based round of the close. A resumed close keeps the numbering it stopped at.
- `txIndex`: zero-based position of the transaction in its round (not on `preparing`).
- `txCount`: how many transactions the round holds (not on `preparing`).
- `covers`: the plan steps the transaction covers. API metadata until `confirmed`, which carries
  what `onConfirmed` is given: with `reconcile`, a merge only when the client parsed one.
- `moreRoundsExpected`: the API asked for another round after this one. Rounds are planned from
  live state, so the close then holds at least `txCount` transactions and its total is not
  known; never show `txCount` as the total while this is `true`.

The callback only observes: each event is a fresh object, nothing it returns is awaited, and
anything it throws is ignored. `onProgress(message)` still gets its plain messages.

## Headless example

[`examples/headless-close.ts`](https://github.com/LumenWipe/lumenwipe/blob/main/packages/sdk/examples/headless-close.ts)
closes a throwaway testnet account end to end from a plain Node/Bun process, with no browser or
web UI: it funds two accounts, then runs `getAccount`, `closePlan`, `closeTransactions` and
`submit` through `runClose`, signing with an in-process keypair. It verifies every transaction
before signing with `@lumenwipe/verify` (`examples/verify.ts`), which is the pattern to copy.

```bash
LUMENWIPE_API_KEY=... bun run --filter '@lumenwipe/sdk' example:headless
```

`LUMENWIPE_API_URL` overrides the default `https://api.lumenwipe.com`. Testnet only.

## Recording what arrived

After a close, read the XLM that reached the destination from the ledger rather than from the
plan. Collect the hashes `runClose` confirmed, then ask once:

```ts
const hashes: string[] = [];
await runClose({ ...deps, onConfirmed: (_tx, hash) => hashes.push(hash) });

const delivered = await client.closeDelivered(destination, hashes);
for (const entry of delivered.entries) {
  if (entry.status === "delivered") record(entry.hash, entry.amountStroops);
  else record(entry.hash, `unavailable: ${entry.reason}`); // not_found, failed or no_delivery
}
// Set only when every entry was delivered: never treat its absence as zero.
if (delivered.totalStroops !== undefined) record("total", delivered.totalStroops);
```

Only a merge into the destination, or the relay account's forward of a merged balance, counts.
A transaction that delivered nothing this way, such as a cleanup round, is `no_delivery`, so pass
the hashes whose amount you want: up to 20 per call.

## Verification is the caller's responsibility

This SDK does not verify or sign anything. Every transaction it returns is unsigned XDR built by
the API from data you provided - before signing, your own code must independently confirm the
transaction does exactly what the user asked (correct destination, no unexpected operations, no
added signers, matching amounts) using values from your own inputs, never from the API response
alone. [`@lumenwipe/verify`](https://github.com/LumenWipe/lumenwipe/tree/main/packages/verify)
is that check: the verifier LumenWipe's own web client signs with, compiled from
[`apps/web/lib/stellar/verify.ts`](https://github.com/LumenWipe/lumenwipe/blob/main/apps/web/lib/stellar/verify.ts),
with a conformance vector set. Pass it as `runClose`'s `verify` (see the docs' Verification page).
Never sign a transaction from this SDK without it or an equivalent check.

## API surface

- `health()` / `healthDeep()` - service health, and whether Stellar RPC is reachable on every
  network (a degraded service throws its 503, never retried).
- `getExchangeRegistry()` - the exchange registry the API closes against; do not rely on it past
  `validUntil`.
- `getAccount(address, network?)` - current on-chain state for an account.
- `getPaths(params, network?)` - conversion path quotes for a source asset.
- `closePlan(body, network?)` - a preview of the full close plan, with blockers if any step
  cannot be closed safely.
- `batchPlan(body, network?)` - plans up to 20 accounts into one destination, read-only.
- `closeTransactions(body, network?)` - builds the next round of unsigned transactions.
- `submit(signedXdr, network?)` - submits a signed transaction.
- `mediatorCheck(address, network?)` / `mediatorSign(transaction, network?)` - the exchange
  mediator flow (see the architecture doc).
- `getTransaction(hash, network?)` / `closeStatus(source, network?)` - look a transaction up by
  hash, and read a close's phase from live state.
- `closeDelivered(destination, hashes, network?)` - the XLM confirmed close transactions
  delivered to the destination, read from the ledger's result (see below).
- `feeBumpSponsor(transaction, network?)`, `getAllowances(address, network?)` and
  `revokeAllowance(params, network?)` - fee sponsorship and the allowance inspector.
- `getStats(network?)` / `getStatsFeed(network?)` / `recordMerge(txHash, network?)` - close
  totals, and counting a close submitted outside the API.
- `runClose(deps)` - drives the full fetch/verify/sign/submit loop to completion.

Every call uses the API's `/v1` paths, except `health()` and `healthDeep()`.

`LumenWipeIntegratorClient` is a separate entry point for a wallet's own API keys: `challenge`,
`session`, `listKeys`, `createKey`, `revokeKey` and `rotateKey`. It takes no API key and never
sends one; the key calls carry only the wallet's session token. See the SDK docs.

Request and response types come from `@lumenwipe/types` and are re-exported from this package, so
no separate install is needed.

## Errors

- `LumenWipeApiError` - thrown on any non-2xx API response; carries `status`, `code`, `details`,
  `retryAfterMs`, `requestId` and the parsed error `body`. Narrow with `isApiErrorCode`.
- `LumenWipeAbortError` - thrown when the `signal` you passed aborts the request.
- `LumenWipeInvalidNetworkError` - raised before any request when `network` is not `"mainnet"` or
  `"testnet"`.
- `LumenWipeTimeoutError` - thrown when a request exceeds the configured `timeout`
  (default 30s).

## Links

- [Architecture](https://github.com/LumenWipe/lumenwipe/blob/main/docs/architecture.md)
- [Full documentation](https://docs.lumenwipe.com/sdk/overview)
- [Issues](https://github.com/LumenWipe/lumenwipe/issues)

## License

Apache-2.0
