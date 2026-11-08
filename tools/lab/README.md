# Latency lab

A command-line tool, run by a person on their own machine, that measures how long the LumenWipe API takes to
answer. No workflow runs it (`tests/no-workflow.test.ts` fails one that does), and no credential is kept in this
repository.

- `measure` sends requests that only read: it never signs and never moves funds.
- `e2e` closes a disposable account for real, and only behind the guards listed below.

Results are written to the lab folder on the machine that ran the tool. They are not committed to this
repository.

## The lab folder

Everything the lab reads or writes lives in `~/.lumenwipe/lab/`, or the folder named by `LUMENWIPE_LAB_HOME`.
The lab refuses a folder, key file or results path that resolves inside a repository checkout. It also refuses
a key file or `config.json` that anyone other than its owner can read (`chmod 600`).

```
~/.lumenwipe/lab/
  config.json        optional for measure, required for e2e
  keys/api-key       production API key (or set LUMENWIPE_LAB_API_KEY)
  keys/source.secret e2e only: the disposable account's secret
  results/<time>/    table.md and results.json for each run
```

`config.json`, with every field optional:

```json
{
  "productionUrl": "https://api.lumenwipe.com",
  "local": { "env": { "STELLAR_RPC_MAINNET": "https://..." } },
  "e2e": {
    "sourceSecretFile": "keys/source.secret",
    "destinations": ["G..."],
    "balanceCapXlm": 20,
    "horizon": { "testnet": "https://horizon-testnet.stellar.org" }
  }
}
```

`local.env` accepts only provider endpoints and their keys: `STELLAR_RPC_*`, `PATH_ROUTING_API_*`, their
`*_HEADER_NAME_*` / `*_HEADER_VALUE_*` pairs, `OCTOPOS_API_URL_MAINNET`, `OCTOPOS_API_KEY` and
`SOROSWAP_API_KEY`.

## measure

```bash
bun run lab measure                                   # production and local, testnet and mainnet
bun run lab measure --target local --network testnet  # no API key needed
bun run lab measure --runs 11 --rounds 3 --scenario analyze-dense,plan
```

Each scenario sends `--runs` requests (5 to 11, 5 by default) per round, one at a time, for `--rounds` rounds
(1 by default), with `--pause-ms` between requests (300 by default). The first request of a round is **cold** and the rest are **warm**. The table reports the p50
and p95 of each, using nearest rank, so every figure is a measured value, with the number of samples
behind it: with one round, cold is a single request.

- **`--target production`** (black box) calls `productionUrl` with the key from `LUMENWIPE_LAB_API_KEY` or
  `keys/api-key`, and refuses to start without one. The key is sent only as `Authorization: Bearer` and is
  never written anywhere. The lab cannot choose which instance answers, so a cold request there is the first
  of the round, not necessarily a cold start.
- **`--target local`** (white box) builds the API (`--no-build` skips that step). For every round of every
  scenario it starts a fresh `node apps/api/dist/main.js`, the runtime production uses, so a cold request
  really is the process's first. The process:
  - runs in an empty temporary folder, so it reads no `.env.local` or other env file;
  - gets only the environment the lab sets: the public providers (or `local.env`) and a throwaway API key
    that exists only for that run;
  - listens on a free port on all interfaces for the length of the round.

  The public providers rate-limit bursts, which shows as 503 `service_unavailable` in the statuses column;
  `--pause-ms` spaces the requests. Without `OCTOPOS_API_URL_MAINNET` in `local.env`, a mainnet plan reports
  that DeFi positions are unconfirmed, as any API without the position indexer would, so `transactions` is
  refused with 422 on mainnet.

  The lab waits for `/health` before measuring, so the local `health` scenario is never cold.

  A preload records each upstream call the API makes, with its kind and RPC method or Horizon route, and
  never its URL, host or headers. The second table breaks each scenario down into those calls and the API's
  own time: the request time with no upstream call in flight, which for `plan` and `transactions` is plan
  and transaction building.

Scenarios run on each selected network. They read public accounts of known shapes (listed in
`src/scenarios.ts`). A fixture that has disappeared, for example after a testnet reset, is reported as
missing.

| Scenario           | What it measures                                                                   |
| ------------------ | ---------------------------------------------------------------------------------- |
| `health`           | The process alone, with no upstream call                                           |
| `analyze-baseline` | Analysis of an account with no sub-entries                                         |
| `analyze-dense`    | Analysis of an account with hundreds of sub-entries (Horizon enumeration)          |
| `analyze-token`    | Analysis of an account holding a Soroban token outside the curated lists           |
| `analyze-defi`     | Mainnet only: analysis of a DeFi position (position indexer or `getLedgerEntries`) |
| `allowances`       | Allowance discovery                                                                |
| `paths`            | A conversion path lookup                                                           |
| `plan`             | `POST close/plan`                                                                  |
| `transactions`     | `POST close/transactions`: an unsigned build, nothing signed or submitted          |

Before writing any file, the lab checks its text. It refuses to write a header name, a key of a known shape,
or any key or provider value it was given.

## e2e

```bash
bun run lab e2e --target local --network testnet --destination G...           # dry run
bun run lab e2e --target local --network testnet --destination G... --submit  # closes the account
```

The account is the one whose secret is in `e2e.sourceSecretFile`. By default the run is dry: it analyzes,
plans, builds the first round and checks every transaction with `@lumenwipe/verify`, then stops without
signing.

`--submit` closes the account and cannot be undone. It refuses to run unless all of the following hold:

- `--network` is given. There is no default.
- The destination is valid, is not the source, and appears exactly in `e2e.destinations`.
- The source, read from Horizon and never only from the API being measured, holds at most the cap of native
  balance: 100 XLM, or lower if `balanceCapXlm` sets one.
- The source has its own key as its only signer on Horizon, and the API's read of the balance, signers and
  thresholds agrees with Horizon's.
- The plan has no blocker and asks for no decision beyond acknowledging the destination.
- A person at a terminal types `CLOSE` followed by the last six characters of the source. Input from a pipe
  is refused.

Every transaction is checked by `@lumenwipe/verify` before it is signed. After the close, the run confirms on
Horizon that the source account is gone. Each step's time is written to `results/e2e-<time>/e2e.json`.
