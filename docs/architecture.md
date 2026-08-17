---
title: "Technical architecture"
sidebarTitle: "Architecture"
description: "System design, data sources, the execution plan, Soroban and DeFi integration, the mediator flow, security, and roadmap."
icon: "sitemap"
---

> Consolidated architecture for LumenWipe, an open-source tool that cleanly closes a Stellar account and recovers its locked reserves.
>
> Reference implementation extended by this project: [stellar.expert/demolisher/public](https://stellar.expert/demolisher/public) by Orbit Lens.

## Contents

1. [What this is](#1-what-this-is)
2. [The problem](#2-the-problem)
3. [How a Stellar account closes](#3-how-a-stellar-account-closes)
4. [System architecture](#4-system-architecture)
5. [Data sources, and why we run no indexer](#5-data-sources-and-why-we-run-no-indexer)
6. [Frontend architecture](#6-frontend-architecture)
7. [The API service](#7-the-api-service)
8. [The execution plan](#8-the-execution-plan)
9. [Closing positions: classic and Soroban DeFi](#9-closing-positions-classic-and-soroban-defi)
10. [Asset conversion and routing](#10-asset-conversion-and-routing)
11. [The mediator account flow for exchanges](#11-the-mediator-account-flow-for-exchanges)
12. [Allowance inspection](#12-allowance-inspection)
13. [Security model](#13-security-model)
14. [Trust minimization and decentralization](#14-trust-minimization-and-decentralization)
15. [Infrastructure and deployment](#15-infrastructure-and-deployment)
16. [User protection and privacy](#16-user-protection-and-privacy)
17. [Testing strategy](#17-testing-strategy)
18. [Maintenance after launch](#18-maintenance-after-launch)
19. [Delivery plan](#19-delivery-plan)
20. [Traction](#20-traction)
21. [Technology stack and standards](#21-technology-stack-and-standards)
22. [Failure modes and recovery](#22-failure-modes-and-recovery)
23. [Open questions and known risks](#23-open-questions-and-known-risks)
24. [Glossary](#24-glossary)
25. [References](#25-references)

Companion documents sit alongside this one:

- [Executive summary](/executive-summary): a one-page overview for a first read.
- [Community and communications](/community-and-communications): building in the open, update cadence, and decentralized social presence.

---

## 1. What this is

LumenWipe is a guided, non-custodial tool that walks a user through closing a Stellar account from start to finish. It removes everything that holds an account open, converts leftover assets to XLM, and merges the account into a destination address, returning the locked reserves to the user.

"Closing" a Stellar account is not a single operation. An account can only be merged once it holds no subentries apart from its signers and sponsors no other account. Getting there means unwinding whatever the account accumulated over its life: trustlines, open DEX offers, data entries, extra signers, liquidity pool shares, and positions in DeFi protocols such as Blend, Aquarius, Soroswap, Phoenix, and FxDAO. Each of those steps is its own transaction, with its own ordering constraints and its own failure modes.

The project extends the public-domain [stellar.expert/demolisher/public](https://stellar.expert/demolisher/public) tool built by Orbit Lens. That tool handles the classic case well: it cancels offers, sells assets on the SDEX, removes trustlines and data entries, works with multisig accounts, and can merge into exchange addresses through an intermediary account. It does not support Soroban, so any account with a Blend loan, an Aquarius LP position, or a Soroswap pair share cannot be closed with it today. This project keeps the parts that work, rebuilds them on the current Stellar stack, and adds full Soroban and DeFi parity, an API-first backend that builds the wind-down, an allowance inspector, and a production-grade UX designed for irreversible actions. Beyond the guided UI, two things widen who can use it: sponsored fees close accounts that hold only their locked reserves and cannot pay their own transaction fees (Section 8.1), and a REST API plus a TypeScript SDK let wallets and platforms drive the same wind-down programmatically (Section 7.3).

An API service builds every unsigned transaction; the browser independently verifies each one against the user's own stated intent before it signs, and your account's secret keys never reach a server. The API holds no user funds and no user keys. Its only signing key is the shared exchange mediator, which it uses solely to co-sign the forwarding payment to an exchange (see section 11).

The codebase is a Bun-workspaces monorepo: a NestJS **API** service (the product), a thin Next.js **web** client, and two published packages - a **TypeScript SDK** (a fetch client for the API) and a shared **types** package. The web reaches the API only through a server-side proxy, so a browser never holds an API key.

Core stack at a glance:

| Layer          | Choice                                                          |
| -------------- | --------------------------------------------------------------- |
| API service    | NestJS, TypeScript - builds the transactions, stateless, cached |
| Web client     | Next.js, TypeScript, open source - verifies and signs only      |
| SDK / types    | `@lumenwipe/sdk` (thin fetch client, no Stellar SDK), `@lumenwipe/types` |
| Stellar SDK    | `@stellar/stellar-sdk` (classic and Soroban), server-side       |
| Wallets        | stellar-wallets-kit (SEP-43), plus an in-memory secret-key mode |
| Network access | Stellar RPC: live reads, simulation, submission, events         |
| Enumeration    | One Horizon-compatible endpoint, provider set by configuration  |
| Routing        | Soroswap API, with SDEX paths as fallback                       |
| DeFi detection | OctoPos DeFi Position API                                       |

## 2. The problem

Stellar has more than ten million accounts on mainnet, and a large share of them are stale, abandoned, or effectively locked. Two structural facts create the problem.

First, every account locks XLM in reserve. The base reserve is currently 0.5 XLM (a network-voted parameter). Since CAP-33, an account's minimum balance is `(2 + numSubEntries + numSponsoring - numSponsored) × base reserve`: two base reserves for the account itself, one per subentry it owns (each trustline, offer, data entry, and extra signer), plus one per entry it sponsors for others, minus one per entry of its own that someone else sponsors. A pool-share trustline counts as two base reserves. So an account with four trustlines, two offers, one data entry, and one extra signer locks `(2 + 8) * 0.5 = 5 XLM` that the user cannot spend until the entries are removed. Across millions of accounts, this is a meaningful amount of capital frozen in the ledger.

Second, closing an account cleanly is a manual, multi-step process that most users cannot perform. Any leftover entry causes the final `ACCOUNT_MERGE` to fail with `ACCOUNT_MERGE_HAS_SUB_ENTRIES`. A user has to know to cancel every offer, exit every DeFi position, sell every asset, remove every trustline, and clear every data entry, in a valid order, before the merge will succeed. Miss one and the merge reverts. (Extra signers are the one kind of subentry that does not block the merge: the protocol's check excludes them, and they are deleted with the account.)

Centralized exchanges make it worse. No major exchange supports `ACCOUNT_MERGE`. A user who wants to send their remaining XLM to an exchange cannot merge directly into a deposit address, so the final 1 XLM minimum balance stays frozen on the ledger. The reference demolisher solves this with an intermediary account, and this project keeps that approach.

Three groups of users feel this most: individuals consolidating or abandoning wallets, exchanges that need to help users recover funds, and DeFi users with open positions across Stellar protocols. The last group has no tool today, because the existing demolisher has no Soroban support.

## 3. How a Stellar account closes

`ACCOUNT_MERGE` transfers the entire XLM balance of the source account to a destination and deletes the source account from the ledger. The protocol enforces strict preconditions. The pre-flight analysis in this tool exists to detect and clear every one of them before it builds a merge transaction.

The merge fails with one of these result codes if a precondition is unmet:

| Result code                     | Cause                                                                                                       | How the tool resolves it                                                                                                                                                                                               |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ACCOUNT_MERGE_HAS_SUB_ENTRIES` | Source still has trustlines, offers, or data entries (signers are excluded from this check by the protocol) | Remove every blocking subentry in earlier steps before the merge                                                                                                                                                       |
| `ACCOUNT_MERGE_IS_SPONSOR`      | Source sponsors reserves for another account                                                                | Detected in pre-flight; entries whose owner can absorb the shifted reserve are auto-resolved via `RevokeSponsorship` (per-owner affordability check), the rest surface as a specific per-entry blocker - see issue #72 |
| `ACCOUNT_MERGE_IMMUTABLE_SET`   | Source has the `AUTH_IMMUTABLE` flag set                                                                    | Detect in pre-flight, block with a clear explanation (the account cannot be merged)                                                                                                                                    |
| `ACCOUNT_MERGE_SEQNUM_TOO_FAR`  | Source sequence number is above the current ledger bound                                                    | Surface the condition; rarely hit in practice                                                                                                                                                                          |
| `ACCOUNT_MERGE_NO_ACCOUNT`      | Destination does not exist                                                                                  | Verify the destination on the ledger before submitting                                                                                                                                                                 |
| `ACCOUNT_MERGE_DEST_FULL`       | Destination balance would overflow the int64 maximum, accounting for its XLM buying liabilities             | Surface as a blocker                                                                                                                                                                                                   |
| `ACCOUNT_MERGE_MALFORMED`       | Source equals destination, or otherwise malformed                                                           | Validation rejects this at input time                                                                                                                                                                                  |

The pre-flight checks map directly onto these codes. Sponsorship detection and revocation resolve `ACCOUNT_MERGE_IS_SPONSOR` for every sponsored entry kind that can be revoked. Subentry enumeration and removal prevent `ACCOUNT_MERGE_HAS_SUB_ENTRIES`. Destination verification prevents `ACCOUNT_MERGE_NO_ACCOUNT`. The tool never submits a merge it expects to fail.

Note that being a _claimant_ of a claimable balance does not block the merge, but _sponsoring_ one does, because the sponsor carries its reserve (one base reserve per claimant, not per balance). An account that created claimable balances is their sponsor unless the sponsorship was later transferred, so those must be resolved first.

**Claimable-balance sponsorships cannot be self-revoked.** CAP-33's `RevokeSponsorshipOp` fails
with `REVOKE_SPONSORSHIP_ONLY_TRANSFERABLE` when applied to a `CLAIMABLE_BALANCE` ledger entry
unless a cooperating new sponsor is sandwiched around it via `BeginSponsoringFutureReserves` /
`EndSponsoringFutureReserves` in the same transaction - every other sponsorable entry kind
(account, trustline, offer, data entry, signer) instead reverts to its own owning account's
default sponsorship, which is what this tool's `REVOKE_SPONSORSHIP` step relies on. A guided
close has no third party willing to become that new sponsor, so a claimable balance this account
sponsors is a permanent blocker until a claimant claims it (removing the entry, and its
sponsorship, entirely) - there is no self-service remediation. See issue #72's implementation
plan for the full CAP-33 citation.

## 4. System architecture

The system has three layers: an **API service** that reads account state, aggregates data, and builds every unsigned transaction (and co-signs one thing, the exchange forwarding payment); a **browser client** that verifies each unsigned transaction against the user's own choices and signs it locally; and the Stellar network plus the external data services the API reads from. The trust boundary is still the browser, but the guarantee is sharpened: a user's account keys and signing live entirely on the client side, and the browser never signs bytes it has not first verified. The API builds the transaction, but a client-side `verify()` decides whether it gets signed, and it checks the transaction against the user's own stated intent rather than trusting the API's word. The API's only key is the shared mediator, which can co-sign the exchange forwarding payment but cannot sign for a user's account, change a destination, or move a user's funds.

![Three-layer system architecture: API service builds transactions, browser trust boundary verifies and signs, and Stellar network with external data services](./diagrams/output/01-system-architecture.svg)

Two things to read off this diagram. The unsigned XDR is built by the API and returned to the client; the client verifies it, signs it, and submission is routed back through the API. The API is not in the signing path for a user's account - it can build and propose a transaction, but only a client-side signature (applied after `verify()` passes) makes it valid, and its only signature of its own is the shared mediator's co-signature on the exchange forwarding payment (section 11). And every external read source is pluggable: RPC, the indexer, the routing API, and the DeFi position API can each be swapped for another provider without touching the transaction logic.

## 5. Data sources, and why we run no indexer

Building LumenWipe requires reading account state, and that state lives in two places the same way the network splits its tooling: classic ledger state, and live or Soroban state.

A practical constraint shapes the whole data design. Stellar RPC's `getLedgerEntries` can only return entries whose keys you already know. You pass it serialized `LedgerKey` values (up to 200 per request) and it returns those exact entries. It has no scan, filter, or "list all trustlines for this account" capability. To build a trustline `LedgerKey` you already need the asset; to read an offer you already need the offer ID. RPC alone therefore cannot tell you what an unknown account holds.

Enumerating an account's subentries (every trustline, offer, data entry, claimable balance, pool share, signer, and sponsorship relationship) requires an indexer. The project takes a clear position here: we do not build or operate an indexer. Stellar RPC is used wherever it serves the read, and everything it cannot serve comes from a single Horizon-compatible endpoint. This is not a preference: `getAccount` returns only the sequence number and base reserve, and `getLedgerEntries` fetches a ledger entry whose key is already known but cannot *enumerate* an account's trustlines or offers. Horizon's deprecation in favor of Stellar RPC does not change that, because its named successor cannot do this job. The provider is set by configuration (`PATH_ROUTING_API_*`), so moving between SDF's public instance, Blockdaemon, Validation Cloud, QuickNode or a self-hosted Horizon is a config change rather than a code change. SDF reduced its hosted Horizon to one year of history in August 2024 and steers integrators toward Stellar RPC plus ecosystem data services; the reads this tool takes from Horizon-compatible endpoints are current-state queries, unaffected by that history truncation. Running a bespoke indexer (Captive Core, Galexie, a database) is not the problem this project exists to solve, and it would be operational weight with no payoff for the tool.

Instead the tool reads from existing, production-grade sources through pluggable adapters:

| Concern                                                                                   | Source                                                                                                                              | Why                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enumerate trustlines, pool shares, signers, thresholds, flags and the subentry count      | One Horizon-compatible endpoint, `GET /accounts/{id}`                                                                               | RPC cannot enumerate. A single response carries all of it, so the read cost does not grow with what the account holds.                                                  |
| Enumerate open DEX offers and claimable balances                                          | The same endpoint, paginated collections                                                                                            | Current-state queries, unaffected by any provider's history truncation. Data entries arrive with the account read above.                                                |
| Alternate enumeration providers                                                           | Any Horizon-compatible provider or Stellar-native indexer (Mercury, SubQuery, and similar)                                          | Keeps any single read source from becoming a hard dependency.                                                                                                           |
| Live ledger-entry reads for known keys, right before building each transaction            | Stellar RPC `getLedgerEntries`                                                                                                      | Authoritative current state. Builds exact transaction parameters and avoids acting on stale data.                                                                       |
| Soroban simulation (footprint, authorization, resource fees)                              | Stellar RPC `simulateTransaction`                                                                                                   | Required for every `InvokeHostFunction` operation.                                                                                                                      |
| Transaction submission and confirmation                                                   | Stellar RPC `sendTransaction`, `getTransaction`                                                                                     | The client submits through the API, which calls RPC; confirmation is polled.                                                                                                                                      |
| Contract events (for example, discovering `approve` spenders for the allowance inspector) | Stellar RPC `getEvents`, with the indexer for older windows                                                                         | RPC retains a bounded event window.                                                                                                                                     |
| DeFi position detection across protocols                                                  | OctoPos DeFi Position API                                                                                                           | Builds on a funded DeFi Position API instead of reinventing protocol indexing.                                                                                          |
| Swap routing and swap-XDR construction                                                    | Soroswap API (primary), Horizon-compatible `/paths/strict-send` (classic SDEX fallback)                                             | Best-available routes across Soroban and classic venues.                                                                                                                |
| Exchange and anchor registry (mediator and memo rules)                                    | Static JSON sourced from the stellar.expert directory                                                                               | Determines which destinations need the mediator flow and a memo.                                                                                                        |

The split is deliberate. An indexer answers "what does this account hold". RPC answers "what is the exact current state of this specific entry, right now, and will this transaction succeed". The tool enumerates with the indexer, then re-reads each entry over RPC immediately before building the transaction that touches it, so it never signs a transaction based on stale enumeration data. As a completeness check, the enumeration result is reconciled against the account's `numSubEntries` counter from the live `AccountEntry`: if the counts disagree, the tool surfaces a blocker instead of building a plan that would miss an entry.

### Accounts of any age

Account age never limits this design, and that is worth stating precisely because Stellar RPC does have a retention window. The window (at most 7 days) applies only to history-shaped methods: `getTransactions`, `getTransaction`, and `getEvents`. It does not apply to `getLedgerEntries`, which reads the current ledger snapshot: a trustline created in 2015 and a trustline created yesterday are the same read. Closing an account needs no transaction history at all; it needs current state, which RPC serves for any account regardless of age, and enumeration, which the indexer serves from full history. The one age-correlated wrinkle is Soroban state archival: a long-dormant account's contract entries (a DeFi position, a token balance) may have expired to the archive, where a plain read no longer sees them. The tool detects archived entries and inserts a `RestoreFootprint` step before the exit that needs them (Section 22). Classic entries never archive.

![Data flow: enumerate via stellar.expert indexer, re-read live over RPC, build and simulate the execution plan, then submit](./diagrams/output/02-data-flow.svg)

### Data freshness and consistency

DeFi position data is a snapshot, and acting on a stale snapshot would build a wrong exit. The position API returns freshness metadata with every response: a staleness value in seconds, the last indexed ledger, and a partial-result flag when some protocols could not be read. The tool uses this directly. If position data is older than a short threshold it refreshes before building the plan, and it shows the ledger and staleness so the user knows how fresh the view is.

Consistency across the boundary between enumeration and execution is the harder problem. Enumeration says a trustline or position exists; the exact amount can move before the user signs. The tool's guarantee is the live re-read: every transaction is built from a fresh `getLedgerEntries` read of the specific entries it touches, taken immediately before construction, not from the enumeration snapshot, and Soroban exits are simulated against current state before signing. Enumeration decides what to do; a live read decides the exact parameters. That keeps the tool from acting on data that moved.

## 6. Frontend architecture

The frontend is a Next.js application in TypeScript, and a thin client of the API. It owns no transaction construction: it requests unsigned transactions from the API, verifies each one locally, signs it, and submits it back through the API. A `no-restricted-imports` boundary lint forbids the web from importing any transaction-building code, so this stays true. It holds the entire flow as an explicit state machine so a user can leave and resume without losing progress, which matters because a full wind-down is several sequential transactions, not one.

The user-facing flow asks for one thing at a time, in the order the work actually needs it. Entry collects only the source account's public key, nothing else - supplied either by pasting it or by connecting a wallet. The analyze stage reads the account and presents a grouped accordion preview of everything that has to be unwound, and for each non-XLM balance the user makes a per-asset decision: swap it to XLM when a route exists, or return it to its issuer when no route does. The return-to-issuer choice is always an explicit confirmation, never a default, and the tool never labels it as a conversion. The destination address and an optional memo are entered last, on the same screen, once the user has decided what the close will do. Exchange detection happens at that point, because it depends on the destination. Only then does the tool build and run the close, and the completion page shows a grouped summary of what happened to each balance and where the reserves went.

### 6.1 State machine

![Demolish flow state machine: Idle → Analyzing → PreflightComplete → StepExecuting ↔ StepFailed → Complete](./diagrams/output/03-state-machine.svg)

Each transition is written to a local session store in IndexedDB. The store holds the source and destination addresses, the network, the ordered plan, which steps have confirmed and their transaction hashes, and the shared mediator public key when an exchange destination is in use. It never holds secret keys or fully-signed envelopes beyond the step currently in flight. On re-entry the tool re-runs the analysis and reconciles against on-chain state, so a step that already confirmed (or was completed externally) is skipped rather than repeated.

### 6.2 Client-side verification (the trust anchor)

The transaction builder lives in the API, not the browser (Section 7). What runs client-side is its counterpart: `verify()`, the trust anchor. Before the browser signs any API-built transaction, it decodes the XDR and asserts, against the user's own choices and a bundled exchange registry, that the transaction does exactly what the user asked and nothing more - a merge only to the stated destination (or the shared mediator), payments only as return-to-issuer or the mediator forward, conversions to self or native with a positive destination minimum, only removals of trustlines, data entries, and offers, `SetOptions` that never adds a signer or raises thresholds and only ever removes a signer that is genuinely on the account, a matching memo value and type, and no unrecognized operation. Any mismatch aborts before signing. Most of what `verify()` checks - destination, memo, and the trustlines the user chose to claim - comes from the user's own inputs, never from the API response, so a compromised API cannot talk the client into diverting funds on those axes. The one exception is the account's real signer set, used only to confirm a `SetOptions` signer removal targets a signer that actually exists: that value is sourced from a separate account-state read (`GET /v1/:network/account/:address`), the same trust domain as the transaction being verified, so it hardens against transaction-builder bugs and partial compromise rather than a wholly hostile API, which could in principle keep that read and the transaction mutually consistent. The pure core is unit-tested against hostile XDR.

The builder it verifies (server-side) enforces the 100-operations-per-transaction protocol limit and splits oversized work into the fewest transactions that limit allows; for Soroban steps it assembles `InvokeHostFunction` operations and defers footprint, authorization, and resource fee to RPC simulation.

### 6.3 Wallet integration and signing

Signing has two paths. The primary path, implemented as the default wallet tab in the ExecutionWizard, is [stellar-wallets-kit](https://github.com/Creit-Tech/Stellar-Wallets-Kit), which provides a unified interface across Freighter, xBull, Albedo, Rabet, Hana, and WalletConnect; the same connection can also be initiated earlier at account entry, persists to the signing step, and is automatically selected as the active signer if the address and network match. (LOBSTR's own kit module is disabled because it cannot sign transactions; LOBSTR users are reached via WalletConnect instead.) The application passes an unsigned XDR and receives a signed XDR through `signTransaction`; the underlying private key never enters the application. For Soroban operations the kit also exposes `signAuthEntry`, though wallet support varies (Freighter, Hana, WalletConnect, and Ledger implement it; several others do not), so the tool builds its Soroban exits with source-account authorization, which the plain `signTransaction` path covers on every wallet, and reserves `signAuthEntry` for the cases that genuinely need a separate auth entry. The secondary path is an advanced secret-key mode for users whose keys are not in any wallet. In that mode the key lives only in memory for the duration of the execution session, never in any persisted storage and never in a network request, and is wiped on completion, on abort, on navigation away from the flow, or when the user explicitly clicks "Forget key". Section 13 details the handling.

![Signing flow: XDR review, wallet or secret-key path, irreversibility confirmation, submit and poll until confirmed](./diagrams/output/04-signing-flow.svg)

For multisig accounts the kit and secret-key paths both support accumulating signatures: the tool collects signatures from several keypairs or wallets in sequence on the same envelope until the account thresholds are met, then submits. Each connected wallet or entered secret key stays active under the same session-scoped lifetime as the single-signer case above - it is not wiped after each individual signature, since a later round of the same close may need the same key again - and is replaced by disconnecting, clicking "Forget key," or connecting a different signer.

## 7. The API service

The API is a stateless NestJS service, and the product itself. It reads account state, aggregates the data the client cannot efficiently fetch, builds the minimal set of unsigned transactions that close an account, and caches its reads. It runs as its own service, deployed separately from the web (Section 15), and every request carries an API key. It accepts no user keys and holds no user funds, and every transaction it returns is unsigned: only the user's browser can turn one into something the network will accept. Its one signing key is the shared mediator, which co-signs the exchange forwarding payment only after validating the transaction shape (operation one merges into the mediator, operation two is a payment from the mediator of at least 1 XLM), and cannot change that payment's destination or amount. If the API were fully compromised it could return a wrong transaction or wrong read data, but the client-side `verify()` refuses to sign anything that does not match the user's intent (Section 6.2), and reads are backed by confirmations and on-chain simulation, so it could never sign for or move a user's account.

Building the transactions server-side shapes the rest of the design. The API re-reads live on-chain state itself right before it builds, so it never emits a transaction based on stale data. It stays stateless across a multi-round close by re-deriving the remaining work from current state on each call rather than tracking per-user progress, which is why an interrupted close resumes by simply asking again. And it validates every request, rejecting a bad memo or an unsupported destination with a typed error the client relays in plain language.

The web never calls the API directly from the browser; it goes through a server-side proxy that injects the API key, so no key ever reaches the client. The SDK wraps the same surface for programmatic callers (Section 7.3). The REST surface:

| Endpoint                                       | Purpose                                                                                                                                                    |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/:network/account/:address`            | Full pre-flight analysis: balances, subentries, sponsorships, multisig, reserves, detected DeFi positions, claimable balances, and computed merge blockers |
| `POST /v1/:network/close/plan`                 | The deterministic, ordered plan for the close, given the destination and the user's per-asset decisions                                                    |
| `POST /v1/:network/close/transactions`         | The minimal set of unsigned transactions for the current round, re-derived from live state; signals when another round is needed                           |
| `POST /v1/:network/submit`                      | Submits a client-signed transaction to the network and returns its hash                                                                                    |
| `GET /v1/:network/mediator/check/:destination` | Whether a destination needs the mediator flow and a memo, and whether the shared mediator is available                                                     |
| `POST /v1/:network/mediator/sign`              | Co-signs the atomic merge-and-forward transaction with the shared mediator key, after validating the exact shape (Section 11)                              |
| `GET /v1/routing/convert`                      | Best conversion route for an asset pair and amount, with estimated and minimum receive amounts                                                             |
| `GET /health`                                  | Component status for the API and its read dependencies                                                                                                     |

Requests are authenticated with an API key and rate-limited per key; the web's proxy holds the key server-side and applies its own per-IP limit on top, so the shared key can never be turned into an anonymous amplifier.

### 7.1 DeFi position adapter

The API consumes OctoPos behind one adapter interface, so the rest of the system never sees provider-specific shapes. OctoPos is a funded DeFi Position API in the Stellar ecosystem, and the API builds on it rather than reinventing protocol indexing. The adapter keeps the provider pluggable: it can be pointed at any compatible provider, and if OctoPos is unavailable the tool enters a degraded mode: classic entries process normally, and the user is warned that DeFi positions could not be detected and must be checked manually.

OctoPos covers position detection across Blend, Aquarius, Soroswap, Phoenix, and FxDAO, plus native wallet balances, and reports claimable AQUA rewards and pending Phoenix rewards alongside the positions. It also exposes two pieces the tool leans on directly: for unsubscribed addresses it returns `queryKeys` (ready-made ledger keys plus pool and pair metadata) so positions can be read straight over RPC `getLedgerEntries` without OctoPos storing anything server-side, which fits this tool's live re-read invariant exactly. One boundary matters for planning: OctoPos serves mainnet only. On testnet the tool discovers DeFi positions through direct contract reads driven by the contract registry, which is the same code path the degraded mode uses, so the fallback stays exercised by every test run.

The provider returns a position payload, an enrichment dictionary (asset symbols, decimals, USD prices and their source, contract names and versions), and a meta block with freshness and confidence fields. The adapter maps these onto one normalized model so the transaction builder sees a single contract:

| Normalized field                                           | Source                         | Use                                                                                   |
| ---------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------- |
| Positions per protocol (supply, borrow, LP, backstop, CDP) | Provider position payload      | Drives which exit steps the plan includes                                             |
| `data_staleness_seconds`, `last_indexed_ledger`            | Provider meta block            | Freshness gate before building the plan (Section 5)                                   |
| `partial_result`                                           | Provider meta block            | Marks protocols the provider could not read; those positions are flagged, not guessed |
| `attribution_confidence`                                   | Provider meta block            | Low confidence triggers a notice to verify positions on an explorer before proceeding |
| Asset and contract enrichment                              | Provider enrichment dictionary | Human-readable labels in the plan view, without extra lookups                         |

The adapter uses the authenticated tier where an API key is configured and the public tier otherwise. It sends only the address it was asked to analyze, and it caches only public position data.

![DeFi position adapter: OctoPos query with freshness gate and degraded-mode fallback when the provider is unavailable](./diagrams/output/05-defi-adapter-fallback.svg)

### 7.2 Caching

Read data is cached with short TTLs, keyed by address: positions for tens of seconds, routing for a few seconds (routing is time sensitive), analysis for a few seconds with explicit refresh on user request. The cache holds public, read-only data. It holds no keys and no user identity.

### 7.3 Integration surfaces: API and SDK

The API is the product, and the guided web app is just its first consumer: it drives the whole wind-down through the same public surface any integrator would use, which is the standing proof that surface is complete. The audiences that close accounts at scale are not clicking through a wizard:

- **REST API**: analysis, plan generation, per-round unsigned-transaction building, mediator co-signing, and submission, so a platform can drive a wind-down from its own backend, verify and sign with its own keys, and submit. It is stateless - each call re-derives the remaining work from live on-chain state - so an operator decommissioning a fleet of deposit or payout accounts just calls again, per account and per round.
- **TypeScript SDK** (`@lumenwipe/sdk`): a thin, dependency-light fetch client over that API that does not bundle the Stellar SDK, so a wallet can embed a "close account" flow inside its own UI and signer. A shared `@lumenwipe/types` package keeps request and response types identical across the API, the SDK, and the web.

The design cost of this is near zero, because the split makes the public surface the only surface: the transaction-building logic lives in one place (the API), the web is a thin client whose lint boundary forbids it from re-implementing any of it, and signing was never coupled to the UI. The audiences are concrete: wallets offering account closure as a feature, platforms with per-user Stellar accounts (payouts, remittances, embedded wallets) recovering sponsored reserves when users churn, and exchanges or anchors giving customers a clean off-boarding path.

## 8. The execution plan

From the analysis the tool generates a deterministic, ordered plan. Same account state, same plan. The order satisfies ledger constraints: you cannot withdraw collateral while a loan is open, you cannot remove a trustline while it holds a balance, and you cannot merge while any subentry remains.

![Ordered nine-step demolish execution plan: normalize signers → remove data entries → claim balances → cancel offers → withdraw LP/AMM → exit DeFi → convert assets → remove trustlines → merge account](./diagrams/output/06-execution-plan.svg)

A few details that matter for correctness:

- Signer normalization runs first when extra signers exist, so a single key can authorize every later step. It removes each extra signer with `SetOptions` weight 0 and sets the low, medium, and high thresholds to 0/1/1. This step is a usability and efficiency choice, not a merge precondition: the protocol's subentry check excludes signers, so an account could merge with them in place. Removing them early collapses a multisig flow to one key for the remaining transactions and turns each signer's 0.5 XLM reserve into spendable balance mid-flow, where it can cover fees.
- Steps with more than 100 operations split into batches of 100, the protocol limit per transaction.
- A step that turns out to be a no-op (no offers, no data entries) is skipped, not submitted.
- Soroban steps are one `InvokeHostFunction` per transaction, because each needs its own RPC simulation for footprint, authorization, and resource fee.
- The plan is recomputed on resume, so external changes between sessions are reconciled rather than blindly repeated.

There is no separate "fast path": producing the minimal set of transactions is simply how the tool closes. For most accounts that minimum is a single transaction, signed once - signer normalization, data removal, offer cancellation, per-asset disposition (each balance swapped to XLM or returned to its issuer), trustline removal, and the account merge, applied atomically in that order. An exchange destination adds one transaction, the co-signed mediator transfer, since exchanges do not accept a direct merge. Some situations inherently need more than one: a claimable-balance account claims first and closes second so the proceeds are not lost; a Soroswap-aggregator swap is a Soroban `InvokeHostFunction`, which a transaction may not mix with other operations, so that conversion becomes its own transaction; and work exceeding one transaction's worth of operations splits across the fewest transactions the 100-operation limit allows. The API re-quotes swap routes at build time, and if an asset has lost its route between analysis and signing it re-decides that asset to a return-to-issuer disposition rather than emitting a transaction that would fail. Because the API re-derives the remaining work from live state on every round, these multi-transaction closes need no server-side progress tracking: the client verifies and signs what it is given, submits, and asks for the next round until none remains.

Because a wind-down can be several sequential transactions, a single end-to-end dry run is not always feasible. The tool's preview approach is two-tiered: a grouped accordion preview up front that gathers everything to be unwound into sections (signers, data entries, offers, positions, and the per-asset dispositions), with the estimated fee and the estimated final XLM that reaches the destination, and a simulation immediately before each signature using `simulateTransaction` for Soroban steps and a build-and-validate check for classic steps. Any simulation failure is surfaced in plain language before the user is asked to sign, never after. The completion page mirrors the preview: a grouped summary of what happened to each balance, the transactions that ran, and where the reserves went.

### 8.1 Sponsored fees: closing accounts that cannot pay their own way

The accounts that most need closing are often the ones that technically cannot start. An account sitting at exactly its minimum balance (the bare 1 XLM minimum, or more XLM locked entirely in subentry reserves) cannot pay even the 100-stroop base fee: the network rejects the transaction with `txINSUFFICIENT_BALANCE` because the fee would take the account below its reserve. Without help, these accounts are stuck holding their own reserves hostage.

The fix is the protocol's fee-bump transaction (CAP-15). The user builds and signs the inner transaction in the browser exactly as in every other step, with its inner fee set to zero. The API wraps it in a fee-bump envelope whose fee source is a dedicated, lightly funded fee account, signs only the outer envelope, and submits. The semantics are exact: the fee account pays the entire fee, the inner source pays nothing, and the inner transaction's signature covers its contents, so the API cannot alter an operation, an amount, or a destination without invalidating the user's signature. The fee account never touches user funds; the only thing it can spend is its own XLM, on fees.

Because this adds a second funded key to an API that otherwise holds only the mediator co-sign key, the surface is deliberately narrow, mirroring the mediator co-sign validation:

- The API decodes the inner transaction and sponsors it only if every operation matches the wind-down shapes (`ChangeTrust` with limit 0, `ManageSellOffer`/`ManageBuyOffer` with amount 0, `ManageData` removals, `SetOptions` signer normalization, `ClaimClaimableBalance`, conversion payments, `AccountMerge` to the session destination).
- The outer fee is capped per transaction, requests are rate-limited per account and IP, and the fee account carries a small operational float with a daily spend cap and alerting. Replay is structurally impossible: the inner transaction consumes the source account's sequence number.

The reserves released by the wind-down repay the sponsorship many times over, so the feature funds itself at the account level. On infrastructure, the ecosystem context is precise and worth stating: SDF deprecated the Launchtube service in March 2026 and designates the OpenZeppelin Relayer as its successor. OpenZeppelin's hosted Channels service requires no infrastructure, but as of mid-2026 it accepts only transactions containing a single `invokeHostFunction` operation, so it can sponsor Soroban steps and nothing else; the fee-bump wrap for classic operations (which is most of a wind-down) exists only in the self-hosted relayer's sponsored-transactions mode. The tool therefore implements the classic fee-bump endpoint inside its own API, which is small (build the envelope, validate, sign the outer layer, submit), and treats the self-hosted OpenZeppelin Relayer as the drop-in alternative for operators who prefer audited policy infrastructure, with the hosted Channels service usable for Soroban-only steps. Fee sponsorship covers transaction fees only; it is distinct from CAP-33 reserve sponsorship, which this flow does not need.

## 9. Closing positions: classic and Soroban DeFi

This is the part the existing reference tool cannot do, and the core of the technical work. Detection and unwinding are separated. OctoPos tells the tool _what_ positions exist across every supported protocol, along with the contract addresses and pool metadata behind them. The tool then constructs every _exit_ transaction itself, reading exact on-chain state over RPC and simulating before signing. It integrates each protocol through its published SDK, public API, or contract interface; it does not guess at contract shapes.

A versioned contract registry maps each pool or vault contract's `wasmHash` to a known protocol version. An unknown `wasmHash` flags that position for manual review rather than risking an exit transaction built against the wrong interface.

The protocols and their exit mechanics at a glance:

| Protocol    | Position type                               | Detection               | Exit mechanism                                                       | Integration                    |
| ----------- | ------------------------------------------- | ----------------------- | -------------------------------------------------------------------- | ------------------------------ |
| Classic DEX | Order-book offers                           | Indexer                 | `ManageSellOffer` / `ManageBuyOffer` with amount 0                   | Native operations              |
| Classic AMM | Pool-share trustline                        | Indexer                 | `LiquidityPoolWithdraw`, then `ChangeTrust` limit 0                  | Native operations              |
| Blend       | Supply (bToken), borrow (dToken), backstop  | Position API            | `Pool.submit` with Repay, Withdraw, WithdrawCollateral; backstop Q4W | `@blend-capital/blend-sdk`     |
| Aquarius    | AMM LP, AQUA rewards                        | Position API, contracts | `withdraw`, `claim`                                                  | Aquarius contracts and backend |
| Soroswap    | AMM LP                                      | Position API, factory   | Router `remove_liquidity`                                            | Soroswap API (builds XDR)      |
| Phoenix     | AMM LP, optional stake                      | Position API, contracts | `withdraw_liquidity`, `unbond` first if staked                       | Phoenix contracts              |
| FxDAO       | CDP vault (XLM collateral, stablecoin debt) | Position API, storage   | `pay_debt`, then withdraw collateral                                 | FxDAO vault contracts          |

Coverage is driven by what users actually hold, not by market share. By current activity, Blend is the largest lending market and Aquarius the largest AMM, FxDAO is an active CDP protocol, and Soroswap and Phoenix are smaller. The tool supports all of them because a user with a position in any of them needs to close it to merge. A position in a frozen, deprecated, or winding-down contract must stay exitable: closing a position is exactly the withdraw-and-repay path such a contract still allows, so the tool reads contract status, surfaces it to the user, and never hides a position because its protocol changed state. The user's funds are still there.

### 9.1 Classic DEX offers

Open offers are cancelled with `ManageSellOffer` or `ManageBuyOffer` carrying the existing offer ID and `amount = 0`, which deletes the offer and frees its 0.5 XLM reserve. Passive sell offers, created with `CreatePassiveSellOffer`, are cancelled the same way. Offers batch at up to 100 per transaction. No external integration is needed; offers are enumerated from the indexer.

### 9.2 Classic Stellar liquidity pools

Stellar's native AMM (CAP-38, protocol 18 and later) holds a user's stake as a pool-share trustline, which costs two base reserves. The only operation that reduces shares is `LiquidityPoolWithdraw`, which burns shares and returns both reserve assets. The unwind is two steps: `LiquidityPoolWithdraw` for the full share balance, then `ChangeTrust` with limit 0 to remove the pool-share trustline. A pool-share trustline cannot be removed while shares remain, so ordering is enforced.

### 9.3 Blend (lending and borrowing)

Blend positions are detected by OctoPos: supply held as bTokens, debt as dTokens, with per-position health factors. The tool builds the exit itself with the official [`@blend-capital/blend-sdk`](https://www.npmjs.com/package/@blend-capital/blend-sdk) through the `Pool.submit` entry point, which takes a list of typed requests, each a `{ request_type, address, amount }`. The relevant request types are `Repay` (5), `Withdraw` (1), and `WithdrawCollateral` (3); supplied and collateralized balances are tracked separately, so the exit uses the request type matching how each position is held. For withdrawals, passing an amount larger than the position clamps down to the actual balance, which the tool uses to fully exit without dust. Repay behaves differently: the pool pulls the full stated amount from the account and refunds any excess in the same transaction, so the tool caps the repay amount at what the account actually holds rather than padding it. (OctoPos ships a Transaction Builder that can construct Blend exits server-side, but its own documentation marks it experimental and unmaintained, so the tool does not depend on it.)

![Blend unwind: detect position, resolve pool version, repay dToken debt, verify health factor, withdraw bToken supply, handle backstop Q4W queue](./diagrams/output/07-blend-unwind.svg)

The order is enforced: repay all dToken debt first, then withdraw bToken supply, because the protocol rejects collateral withdrawal that would leave a position undercollateralized. When the account lacks the asset to repay, the tool routes and acquires it first (Section 10).

Two Blend details round out the exit. BLND emissions are not reported by OctoPos, so the tool reads unclaimed emissions through the Blend SDK and offers to claim them before the exit, which matters because users routinely forget accrued rewards. And Blend's backstop module uses a queue-for-withdrawal (Q4W) cooldown, 21 days on V1 and 17 days on V2 (the backstop token is the BLND:USDC 80/20 Comet LP share on both): if a backstop withdrawal is queued, the tool shows the remaining time for that pool version, proceeds with the rest of the wind-down, and warns that the backstop funds stay locked until the queue clears. Blend has V1 and V2 pools on mainnet, and the SDK ships both contract clients, so the tool resolves the pool version per position before building the exit.

### 9.4 Aquarius (AMM)

Aquarius is a Soroban AMM. LP positions are withdrawn by calling the pool's `withdraw(user, share_amount, min_amounts)`, which burns shares and returns the reserve assets, with a minimum-received tolerance to bound slippage. OctoPos reports claimable AQUA rewards alongside the LP position, the tool confirms the amount on-chain with `get_user_reward(user)`, and claims with `claim(user)` before withdrawal when the user opts in; claiming AQUA may require an AQUA trustline, which the tool adds and then resolves in the conversion step. Aquarius pools can have claiming admin-paused (`kill_claim`), in which case the tool surfaces the paused rewards as a notice instead of failing the exit. Pools and positions are discovered from the DeFi Position API and the Aquarius backend, with direct contract reads over RPC as the fallback.

### 9.5 Soroswap

Soroswap is a Soroban AMM with a public [Soroswap API](https://docs.soroswap.finance/soroswap-api) that returns routes and builds XDR. LP withdrawal calls the router's `remove_liquidity(token_a, token_b, liquidity, amount_a_min, amount_b_min, to, deadline)`. Pairs are enumerated through the factory (`all_pairs_length`, `all_pairs`, `get_pair`), though in practice the DeFi Position API already reports which pairs the account holds. Where the tool relies on the Soroswap API to assemble a transaction, it signs and submits the API-built XDR directly rather than re-simulating it, which sidesteps a known Soroban `simulateTransaction` edge case around restored archival entries.

### 9.6 Phoenix

Phoenix is a Soroban AMM. The pool contract exposes `withdraw_liquidity(recipient, share_amount, min_a, min_b, deadline, auto_unstake)`, where `deadline` is optional and `auto_unstake` takes an optional `AutoUnstakeInfo` (the stake's amount and timestamp) that makes the pool unbond before burning shares. Staking itself lives in a separate contract whose entry points are `bond` and `unbond`, and `unbond` requires the original stake's timestamp, so the tool enumerates individual stakes to exit a staked position. It withdraws the full share balance with a minimum-received bound, unbonding first (or via `auto_unstake`) where a position is staked.

### 9.7 FxDAO

FxDAO is a CDP protocol: a user locks XLM collateral in a vault and mints a stablecoin (USDx, EURx, or GBPx, one denomination per vault). Vaults open at a 115% collateral ratio and liquidate below the 110% minimum, both admin-configurable per denomination. Closing a vault means repaying the stablecoin debt and withdrawing the XLM collateral. The vault contract tracks vaults in a sorted linked list, so debt repayment through `pay_debt` requires passing the neighboring vault keys, and vaults are enumerated through `get_vaults`. When the account does not hold enough stablecoin to repay, the tool acquires it through routing first. If a vault is undercollateralized at close time, automatic closure is not safe (it would invite liquidation), so the tool surfaces a clear error and asks the user to manage that vault manually.

### 9.8 What a protocol exit looks like end to end

For every Soroban exit the shape is the same: detect the position from the DeFi Position API, resolve the contract version from the registry by `wasmHash`, read exact on-chain amounts over RPC `getLedgerEntries` with `ScVal` decoding, build the `InvokeHostFunction` operation, simulate it over RPC to fill in footprint, authorization, and resource fee, present the simulation result to the user, sign client-side, submit, and poll for confirmation. The same adapter pattern that keeps the position provider pluggable isolates each protocol's contract interface, so a protocol upgrade is a registry and adapter change, not a rewrite.

### 9.9 Exit adapter invariants

Because the operations are irreversible, every protocol exit adapter must satisfy the same invariants before its output is signed. These are the contract the adapters are held to, and what the test suite checks.

| Invariant                  | What it guarantees                                                                                                                                                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live re-read before build  | Exit amounts come from a fresh `getLedgerEntries` read taken immediately before construction, never from cached or enumerated data                                                                                               |
| Simulate before sign       | Every Soroban exit is simulated over RPC for footprint, authorization, and resource fee, and the result is shown before the user signs                                                                                           |
| Halt on unknown `wasmHash` | An unrecognized contract version flags the position for manual review and builds nothing, rather than encoding against the wrong interface                                                                                       |
| Clamp to balance           | Exit amounts are clamped to the actual position, so a full exit leaves no dust and never over-withdraws                                                                                                                          |
| Verify server-built XDR    | A transaction built by an external API (the Soroswap API) is decoded client-side and its contract, function, amounts, minimum-received, and destination are asserted against locally read state before the user is asked to sign |
| Minimum-received bound     | Every swap or LP withdrawal carries a minimum-received amount derived from a fresh quote and a slippage tolerance                                                                                                                |
| Repay before withdraw      | Debt is repaid before collateral is withdrawn, and the resulting health factor is checked to stay at or above 1.0                                                                                                                |
| No silent skips            | A position the tool cannot safely close (undercollateralized vault, unknown version, missing route) is surfaced as a blocker with an explanation, never quietly ignored                                                          |
| Deterministic plan         | The same account state produces the same ordered plan, which keeps the flow auditable and testable                                                                                                                               |

These invariants aren't scoped to Soroban exits alone. The two classic-op builders that resolve the merge preconditions from Section 3 hold to the same contract by different means: the `REVOKE_SPONSORSHIP` step re-reads each owner's live sponsorship and reserve headroom immediately before building - a dedicated call, separate from the plan-time affordability check, since minutes can pass between them - and an owner that can no longer absorb the shifted reserve simply drops out of that build rather than failing partway, because it was already surfaced as a `sponsorship_unaffordable` blocker at plan time. The claimable-balance trustline-remediation path reads from the same fresh per-request account state the round already re-read, and a balance that's no longer claimable likewise surfaces as a blocker (`claimable_balance_unclaimable`) or a deliberate, recorded no-op (`claimable_balance_forfeited`) rather than disappearing quietly.

## 10. Asset conversion and routing

After positions are unwound, the account may hold several classic and Soroban tokens. Each non-XLM balance gets an explicit, per-asset disposition the user makes in the accordion preview, because "swap everything" is the common case but not the only one the ledger allows:

- **Swap to XLM** (offered whenever a route exists): swap through the best available route, then remove the trustline. This is the disposition the tool selects for any asset that has a route, and the user can leave it as is.
- **Return to issuer**: send the balance back to its issuer, which clears it from the account. This is the right call for spam tokens, worthless dust, and assets with no route, and it is the only option the tool offers when no swap route exists. It is never the default and never labeled as a conversion: the user confirms it explicitly, and the tool states plainly that it is irreversible.

Claimable balances follow the same explicit-choice pattern through a distinct `DecisionPoint` (`type: "claimable_balance"`, resolved to a `ClaimableBalanceSelection` in `@lumenwipe/types`), since a balance the account is claimant of is a separate ledger entry, not a balance the account already holds:

- **Claim**: submit `ClaimClaimableBalance` for the balance now. Offered, and the opt-out default, whenever the account can already claim it - the asset is native XLM, or an authorized trustline already exists.
- **Add a trustline, then claim**: add the missing trustline first, then claim in the same round. The only path to claiming a balance in an asset the account doesn't yet trust.
- **Forfeit**: leave the balance unclaimed and proceed with the rest of the close. No operation is built; the choice is recorded as an acknowledged blocker so the plan stays auditable about what it chose not to do.

There is no default when a balance isn't currently claimable: the user must pick add-trustline-then-claim or forfeit explicitly, and the API holds the plan at `needs_decisions` until every such balance has an answer.

Routing for the convert path has two engines. The primary is the Soroswap API, which finds optimal routes across Soroswap, Phoenix, Aquarius, and the classic SDEX, handles both classic and Soroban tokens, and builds the swap XDR. Like every server-built transaction, that XDR is decoded and verified client-side before signing (Section 9.9). The fallback for pure-classic assets is strict-send path finding from a Horizon-compatible endpoint, executed with `PathPaymentStrictSend` across SDEX order books and classic liquidity pools (up to six hops). Either way the tool computes a minimum-received amount from the quoted output and a slippage tolerance, and passes it as the destination minimum so a sudden price move cannot fill the swap at a bad rate.

![Asset conversion routing: Soroswap Aggregator as primary route with SDEX PathPayment fallback, minimum-received bound, and return-to-issuer when no route exists](./diagrams/output/08-asset-conversion-routing.svg)

The user keeps control. A trustline is only removed once the protocol's full deletion preconditions hold: zero balance, zero buying liabilities (every open offer buying the asset cancelled, which the step order guarantees), and no pool-share trustline still referencing the asset (pool exits run earlier for the same reason). If a residual balance remains after a swap, the tool offers the return-to-issuer disposition or lets the user lower slippage and retry, rather than silently failing the later merge.

## 11. The mediator account flow for exchanges

Exchanges do not support `ACCOUNT_MERGE`, and their crediting systems only recognize `Payment` operations with a memo, so a user cannot merge directly into a deposit address (a direct merge is typically lost). The tool bridges this with a single shared mediator account, the same pattern the reference demolisher uses, in one atomic transaction.

![Mediator account flow for exchange destinations: one atomic transaction where the user signs the AccountMerge and the API co-signs the forwarding Payment with memo](./diagrams/output/09-mediator-flow.svg)

The mediator is a single, persistent account that the operator funds once. Its ~1 XLM minimum balance is paid once and reused for every close, so the user recovers essentially all of their XLM, including the source account's freed reserves; only standard network fees apply. This is the key difference from a throwaway per-user intermediary, which would sacrifice ~1 XLM on every close.

The transaction is built by the API and verified in the user's browser, where the user signs its merge half. The API then co-signs only the mediator's forward payment, after validating the exact shape: operation one must be an account merge into the mediator, and operation two a payment from the mediator to the user's chosen destination of at least 1 XLM. Because it is one atomic transaction with a fixed destination and amount, the API cannot change where the funds go or divert them; it can only co-sign or refuse. This mediator key is the single server-side signing key in the system (see the security model).

When the destination is a known exchange or anchor, the tool requires the correct memo and blocks submission without it, because funds sent to an exchange without a memo are typically lost. A registry of known exchange and anchor addresses, sourced from the stellar.expert directory, drives two decisions: whether a destination needs the mediator flow, and whether it requires a memo and of which type (text, id, or hash).

The registry is a curated list, not a complete one, so its silence carries no information: an address it does not list may still be an exchange deposit address it has simply never been told about, and every deposit address issued from now on is unlisted by default. Because a direct merge into such an address is unrecoverable, an unrecognized destination is not assumed to be a personal wallet. The close API emits a required `confirmation` decision point, keyed by the address (`destination:G...`), and `close/transactions` refuses to build until it is answered (`422 destination_not_acknowledged`). The decision id names the address so an answer cannot be replayed for a different destination, and the refusal lives on the build endpoint rather than only in the plan because the plan is advisory - an API or SDK caller can reach the build without ever requesting one. Only the user knows where an address came from, so the tool asks them rather than guessing.

## 12. Allowance inspection

Independent of closing an account, the tool offers a read-only allowance inspector. This is a security utility: a user who has approved token spending to DeFi contracts can audit and revoke those approvals, which limits exposure if a protocol is later exploited.

Soroban tokens follow the [SEP-41](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0041.md) interface, including `approve(from, spender, amount, expiration_ledger)` and `allowance(from, spender)`. There is no on-chain way to list every spender an account has approved, so the inspector discovers candidate spenders from `approve` events (RPC `getEvents`, with the indexer for older windows) and from the known DeFi contract registry, then reads `allowance(owner, spender)` for each. Non-zero allowances are shown with the token, the spender contract and its protocol name when recognized, the approved amount, and the expiration ledger. Revoking sets the allowance to zero with `approve(owner, spender, 0, ledger)`, one `InvokeHostFunction` per revocation, and requires no full wind-down.

## 13. Security model

The tool builds transactions that drain an account irreversibly, so its security model starts from the assumption that only the user's own machine should ever be able to sign.

### 13.1 What is at risk and who attacks it

| Asset               | Risk                          | Mitigation                                                                                     |
| ------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------- |
| Private key         | Total account control         | Never transmitted; wallet path keeps it in the wallet; secret-key path keeps it in memory only |
| API-built transaction | A transaction that diverts funds | Built by the API, but verified client-side against the user's own choices before signing (`verify()`, Section 6.2); the client never signs bytes it did not verify |
| Destination address | Funds sent to the wrong place | Full-address display, ledger existence check, explicit verification before merge               |
| Memo                | Lost funds at an exchange     | Required and validated for known exchange and anchor destinations                              |

A compromised API cannot redirect a user's funds. It builds the transactions, but the browser verifies each one against the user's own inputs before signing (`verify()`, Section 6.2), so a transaction that changed a destination, amount, or operation would fail verification and never be signed. For those checks - destination, memo, and the user's own trustline-claim choices - `verify()` takes its expected values from the user rather than the API response, so the API cannot supply its own answer. One check is sourced from the API's own trust domain rather than the user: that a `SetOptions` signer removal targets a signer that actually exists on the account is confirmed against a separate account-state read, not the transaction itself, so it catches a transaction-builder bug or a partial compromise, though a wholly compromised API could in principle keep that read and the transaction consistent with each other. Its only signing key is the shared mediator, which can co-sign only a payment whose destination and amount the user already fixed in an atomic transaction, so it can neither sign for a user's account nor redirect the forward payment. Wrong read data is caught by that same verification, on-chain simulation, and explicit confirmation of every destructive step. A passive network observer sees only TLS-protected traffic. An XSS attacker is blocked by a strict Content Security Policy with no inline scripts, no `unsafe-eval`, and no external scripts, with one intentional exception: `style-src 'self' 'unsafe-inline'` (required by stellar-wallets-kit's runtime style injection). A supply-chain attacker is constrained by lockfile-pinned dependencies, audited in CI, with no dependency permitted that needs dynamic code execution.

### 13.2 Key handling

The wallet path is primary: through stellar-wallets-kit the private key never enters the application. The secret-key advanced mode is for keys not held in any wallet, and is constrained: the input is a password field, the key is held only in memory (never in `localStorage`, `sessionStorage`, IndexedDB, cookies, or any network request) for the duration of the execution session, and it is wiped on completion, on abort, on navigation away from the flow, or when the user explicitly clicks "Forget key". The component holding it is also unmounted when the user leaves the signing step. For multisig, keys are gathered one at a time - the active key signs, and switching to a different wallet or secret key (or explicitly clicking "Forget key") is what clears it, not each individual signature; the underlying memory lifetime is the same one described above for the single-signer case. The shared mediator's secret is the system's one server-side signing key; it lives only in the API's environment, never in the browser, and is used solely to co-sign the exchange forwarding payment (Sections 7 and 11).

### 13.3 Confirmation and irreversibility controls

Every destructive step requires an explicit acknowledgment that states what will happen, shows the affected entry or balance, and warns that it cannot be undone. The tool never auto-submits; the user triggers each submission. The merge gets its own full-screen confirmation with the destination shown in full, a ledger existence check, and memo validation for exchange destinations.

A third layer sits above these two: before any transaction is built or signed, the whole plan is shown at once on a dedicated review step. The client-side `DemolishPhase` state machine (Section 6.1) gates this explicitly - the plan-generation phase (`PREFLIGHT_COMPLETE`) only advances to execution (`STEP_EXECUTING`) through that page's own confirmation, and nothing is written to the resumable session store before it fires, so leaving the tab mid-review has nothing to resume. This is additive to the per-step and per-merge confirmations, not a replacement - confirming the whole plan doesn't skip confirming each step and the merge itself as they happen.

### 13.4 Security reviews

The codebase undergoes internal security reviews as part of our development process. External security audits will be conducted when possible.

## 14. Trust minimization and decentralization

For a tool that closes accounts, decentralization is first a matter of custody and control, and second a matter of how little anyone has to trust the operator.

Custody and control. The tool is non-custodial by construction. A user's account signing is client-side and their keys never reach a server. The API holds one signing key, the shared exchange mediator, used only to co-sign a forwarding payment the user has already authorized in an atomic transaction. No operator of any component, including the maintainers, can change a destination, move a user's account funds, or close their account without the user's own signature. The user authorizes every transaction.

Open code, open surfaces. The whole project is open source under a permissive license. The API that builds the transactions and the client-side `verify()` that guards signing are both open and auditable, and the signing itself runs in the user's browser where anyone can read it. Integrators do not have to go through our UI at all: the REST API and the TypeScript SDK (Section 7.3) let a wallet or platform drive the same wind-down with its own interface and its own signers, so the security-critical path is auditable and embeddable rather than locked behind a hosted product. Every external read source sits behind a pluggable adapter, so the deployment can be pointed at any Stellar RPC provider, indexer, or DeFi Position API instance.

Where centralization remains, and why. The remaining centralized pieces are all read-only data sources: RPC providers, the indexer, the routing API, and the DeFi Position API. None can affect custody. Each is pluggable and has multiple independent providers in the Stellar ecosystem, so no single one is a hard dependency. The DeFi Position API (OctoPos) is a deliberate dependency, kept behind an adapter with an explicit degraded mode, so even there an outage limits functionality rather than breaking the tool.

| Component                          | Ownership                            | Reach               | Notes                                                                                |
| ---------------------------------- | ------------------------------------ | ------------------- | ------------------------------------------------------------------------------------ |
| Web client (UI)                    | Open source                          | Open                | Thin Next.js client; verifies and signs; holds no user keys and no API key           |
| API service                        | Open source                          | Operator-run        | Builds transactions and reads state; no user keys, no custody; one signing key, the shared mediator co-sign |
| Verification and signing           | Open source, runs client-side        | Open                | The security-critical path; `verify()` guards every signature, and signing never leaves the browser |
| Contract and exchange registries   | Open source, community pull requests | Open                | Versioned JSON, updated by reviewed pull request                                     |
| Stellar RPC access                 | Pluggable provider                   | External, read-only | Ecosystem providers, configurable per deployment                                     |
| Subentry enumeration               | Horizon-compatible provider          | External, read-only | Set by configuration; swapping providers requires no code change                     |
| Swap routing                       | Pluggable                            | External, read-only | Soroswap API or SDEX paths                                                           |
| DeFi position detection            | Pluggable                            | External, read-only | OctoPos behind an adapter, with an explicit degraded mode                            |

Nothing here can move a user's funds: the API builds transactions but cannot sign for a user's account, and signing lives only in the browser behind `verify()`. Everything in the external rows is read-only and replaceable.

## 15. Infrastructure and deployment

The tool runs on light, replaceable infrastructure, which follows from the non-custodial design. The codebase is a Bun-workspaces monorepo - `apps/{web,api}` and `packages/{sdk,types}` - with per-package CI so each artifact builds and tests independently.

- API service: a NestJS service that reads state and builds transactions. It holds no per-user state and no user keys (only the shared mediator co-sign key, injected from the environment as a managed secret), so it scales horizontally. It deploys as a container to Google Cloud Run with scale-to-zero (minimum instances 0), so an idle deployment costs nothing and a cold start is a few seconds - acceptable for an infrequent, deliberate close.
- Web client: the Next.js app, deployed to Vercel. It reaches the API only through its own server-side proxy routes, which inject the API key, so the browser never holds one.
- Cache: short-lived public read data only, held in the API.
- Stellar access: Stellar RPC through ecosystem providers, configurable per deployment.
- Data services: one Horizon-compatible endpoint for enumeration and the Soroswap API for routing, both set by configuration; the OctoPos DeFi Position API.

The two services are kept deliberately platform-agnostic - the API is a plain container backed by external, portable data services - so the deployment target stays reversible. The project commits to using the current stable Stellar stack: the latest `@stellar/stellar-sdk`, Stellar RPC, stellar-wallets-kit, and the live network protocol (Protocol 26, Yardstick, on mainnet since May 2026). The contract registry and protocol adapters are versioned so the tool tracks protocol and DeFi upgrades without a rebuild of its core logic.

## 16. User protection and privacy

The tool protects users on two fronts: their funds and their privacy.

Funds. The irreversibility controls in Section 13 are the protection: explicit per-step confirmations, no auto-submission, destination verification, memo validation for exchanges, per-step simulation before signing, and a resume flow that reconciles against on-chain state so an interrupted wind-down never double-acts.

Privacy. The tool collects no personal information and requires no account. Secret keys never leave the browser and are never logged. The API handles only public addresses, which it does not retain beyond cache TTLs, and it associates no identity with a request. Any product analytics are privacy-preserving and self-hosted (for example Plausible or Umami) with no personal data, no cross-site tracking, and IP anonymization; the default is to ship no third-party trackers at all, and the Content Security Policy blocks third-party scripts. Abuse protection is rate limiting by API key at the service and by IP at the web proxy, neither of which needs a stored identity.

## 17. Testing strategy

Testing matters more than usual here because the operations are irreversible and touch real balances. The suite has four tiers; automated tests never touch mainnet. Unit and adversarial/edge-case tests are deterministic fixtures and run automatically in CI on every change. Integration and end-to-end tests run against real Stellar testnet and are manual: integration is gated behind the `LUMENWIPE_RUN_INTEGRATION` environment variable, and Playwright end-to-end is a separate script (`test:e2e`) that `.github/workflows/ci.yml` never invokes. Because the codebase is a monorepo, CI runs every package's checks on each change as a matrix, so a shared type change is validated against every consumer rather than skipped by a path filter.

- Unit: pure logic with deterministic fixtures. Transaction construction, fee estimation, reserve and balance math, routing parameter derivation, state machine transitions, input validation, and batching. The transaction builder is the highest-coverage module.
- Integration: against Stellar testnet with accounts funded by Friendbot at the start of each run. Account analysis, signer removal, offer cancellation, trustline removal, asset conversion, the merge, and each DeFi protocol exit. DeFi detection in these tests runs through the direct contract-read path, since OctoPos serves mainnet only; that keeps the degraded-mode code under permanent test coverage.
- Adversarial and edge case: deliberately unusual or hostile account states. Sponsoring accounts, the 1000-subentry maximum, revoked trustlines, multisig with hash(x) and pre-auth signers, undercollateralized vaults, queued backstop withdrawals, high-slippage conversions, and network failures such as a confirmed transaction whose response is lost (detected on retry through `getTransaction` so the step is not resubmitted).
- End to end: Playwright drives a real browser against testnet through the full flow, including the multisig path, the mediator path for exchange destinations, session recovery, and the allowance inspector.

## 18. Maintenance after launch

The design isolates the parts most likely to change.

Protocols upgrade, and DeFi contracts get redeployed. The versioned contract registry maps `wasmHash` to protocol version, so a new protocol version is a registry update (a reviewed pull request), not a code change. An unknown `wasmHash` degrades gracefully: the affected position is flagged for manual review instead of risking a wrong exit. Each protocol and each data provider sits behind an adapter, so adding a protocol or swapping a provider is a contained change. Dependencies are pinned and audited in CI, with weekly update pull requests. The repository carries a security policy and a responsible-disclosure process. Maintenance commitments, the cadence of protocol-coverage review, and the community update rhythm are detailed in the [community and communications](/community-and-communications) document.

## 19. Delivery plan

The work is delivered in three cumulative tranches, each a working, independently verifiable artifact.

| Tranche                 | Focus                                                                                                                                                                                                                                                                      | Key acceptance criteria                                                                                                                                                                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Classic MVP          | Full classic wind-down on testnet: signer normalization, data entries, offer cancellation, classic liquidity pool withdrawal, asset conversion via SDEX paths, trustline removal, merge, and the mediator flow. Wallet and secret-key signing, multisig, session recovery. | All classic steps execute correctly on testnet; multisig account closed with multiple keys; mediator flow works for exchange destinations; sessions resume from on-chain state; all errors render in plain language; transaction builder above 80% coverage.  |
| 2. Soroban and DeFi     | Full Soroban parity: DeFi position detection via OctoPos; Blend, Aquarius, Soroswap, Phoenix, and FxDAO exits; Soroban token conversion; the allowance inspector; per-step simulation. Sponsored fees for reserve-locked accounts (Section 8.1).                           | Each protocol's positions detected, unwound, and confirmed on testnet; degraded mode when the position provider is down; Soroban fee estimates within tolerance of submitted fees; an account holding only its minimum reserve closed end to end on testnet.  |
| 3. Production hardening | Security review and remediation; mainnet deployment; performance and load validation; final UX from user testing; complete public documentation. Public REST API (batch analysis, per-step XDR) and the TypeScript SDK package (Section 7.3).                              | Security review completed with findings addressed; mainnet deployment live; CSP verified with no `unsafe-eval`; analysis within performance targets; API and SDK documented with a working integration example; repository public under a permissive license. |

## 20. Traction

The classic wind-down already runs. The current codebase is a working monorepo - a NestJS API and a thin Next.js client - that, on both networks, reads account state over Stellar RPC and one Horizon-compatible endpoint, builds the classic transactions in the API, verifies and signs them in the browser, and executes the full path: signer normalization, data entry removal, offer cancellation, asset conversion through SDEX path payments, trustline removal, and `AccountMerge`, including the mediator flow for exchange destinations with the correct memo handling. It carries an exchange registry, IndexedDB session recovery, unit tests over the plan builder and helpers, and Playwright end-to-end coverage. This is the foundation the Soroban and DeFi work builds on, and the evidence that the team is already executing rather than starting from a blank page.

## 21. Technology stack and standards

Plain-English summary of what the tool is built from and why.

- Frontend: Next.js and TypeScript, a thin open source web client that verifies and signs, with TypeScript's type safety guarding the verification and signing path.
- API: NestJS and TypeScript, a stateless service that reads state and builds transactions, with a short-TTL cache for public read data; API-key auth with per-key rate limiting.
- Packaging: a Bun-workspaces monorepo (`apps/{web,api}`, `packages/{sdk,types}`); `@lumenwipe/sdk` is a thin fetch client over the API, and `@lumenwipe/types` is shared across the API, the SDK, and the web.
- Stellar SDK: `@stellar/stellar-sdk`, the official SDK, which covers classic and Soroban, used server-side in the API.
- Wallets: stellar-wallets-kit (Freighter, xBull, Albedo, Rabet, Hana, WalletConnect; LOBSTR is accessible via WalletConnect), including Soroban authorization-entry signing.
- Network access: Stellar RPC for live reads, simulation, submission, and events; the stellar.expert API for subentry enumeration; the Soroswap API for routing; OctoPos for DeFi position detection.
- DeFi integration: the official Blend SDK, the Soroswap API, and the published contract interfaces for Aquarius, Phoenix, and FxDAO, behind per-protocol adapters and a versioned contract registry.
- State and storage: Zustand for the wizard state machine, IndexedDB for resumable sessions (never keys).
- Testing: the Bun test runner for units, Playwright for end-to-end on testnet, with per-package CI across the monorepo.

### Standards we build on

The tool tracks the current stable protocol (Protocol 26, Yardstick, on mainnet since May 2026) and the latest `@stellar/stellar-sdk`. It builds on these ecosystem standards:

| Standard                          | What it is                                          | How the tool uses it                                                                                                                                                 |
| --------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SEP-41                            | Soroban token interface                             | Reads `balance` and `allowance`, revokes with `approve(owner, spender, 0, ledger)` for the allowance inspector, and handles Soroban token balances during conversion |
| SEP-43                            | Wallet interface implemented by stellar-wallets-kit | `signTransaction` across ecosystem wallets with no per-wallet code; `signAuthEntry` where the wallet implements it                                                   |
| CAP-38                            | Classic liquidity pools (protocol 18)               | `LiquidityPoolWithdraw` and pool-share trustline removal                                                                                                             |
| SEP-40                            | Oracle consumer interface                           | Reading a Blend pool's oracle price when validating that a partial repay keeps the health factor at or above 1.0                                                     |
| Stellar Asset Contract (CAP-46-6) | Classic assets usable inside Soroban                | Bridging classic balances and contract balances when converting Soroban-side                                                                                         |

## 22. Failure modes and recovery

The tool never leaves the user guessing. Every failure is either retryable with a clear path or surfaced as a blocker with a manual resolution, and partial progress is always recoverable from on-chain state.

| Failure                                               | What the tool does                                                                                                                     |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| RPC unavailable                                       | Reads pause and retry with exponential backoff; the user sees a clear status and a retry, and no state changes                         |
| Indexer or position API unavailable                   | The classic flow proceeds; DeFi detection enters degraded mode with a warning to verify positions manually                             |
| Partial position data                                 | Affected positions are flagged; the tool builds no exit from incomplete data                                                           |
| Step fails on submission                              | The step is marked failed with a plain-language reason; the user retries the same step; later steps stay locked                        |
| Confirmation response lost                            | On retry the tool checks `getTransaction`; if the transaction already confirmed, the step is marked complete rather than resubmitted   |
| Sequence or fee issue                                 | The tool rebuilds with the current sequence number and a higher fee within the disclosed tolerance, then re-presents for signing       |
| Browser closed mid-flow                               | The session restores from IndexedDB and reconciles against on-chain state; completed steps are skipped                                 |
| Soroban entry archived                                | A long-dormant account may have archived contract entries; the tool detects this and inserts a `RestoreFootprint` step before the exit |
| Undercollateralized vault or unknown contract version | Surfaced as a blocker with an explanation; independent steps in the plan can still proceed                                             |

## 23. Open questions and known risks

These are the items the team is actively resolving. Listing them is deliberate: a tool that drains accounts should be honest about what is still being pinned down.

| Area                             | Open question or risk                                                                                                                                                                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| FxDAO exit                       | Confirm the exact collateral-withdrawal entrypoint and the linked-list neighbor-key handling for `pay_debt` against the current contracts, and the full set of supported stablecoin denominations                                                                              |
| Soroswap simulation              | Confirm the precise `simulateTransaction` edge case and the raw JSON-RPC submission pattern against the current Soroswap API and protocol version                                                                                                                              |
| DeFi Position API specs          | Pin the exact OctoPos fields the adapter maps and coordinate with the OctoPos team; the documented API host and the live deployment currently diverge (endpoint paths and response surface), so the adapter pins against the live contract and treats the docs as aspirational |
| Offer and data-entry enumeration | stellar.expert exposes no listing for open offers or data entries; select and pin the Horizon-compatible current-state provider for those two queries, with `numSubEntries` reconciliation as the completeness check                                                           |
| Dry-run depth                    | A full end-to-end simulation across many sequential transactions is not feasible; user testing must confirm that per-step simulation plus the plan view is enough                                                                                                              |
| Soroban state archival           | Archived ledger entries on dormant accounts may need a `RestoreFootprint` operation before an exit; confirm the handling end to end                                                                                                                                            |
| Coverage drift                   | Protocols change market share and contract versions; the registry and adapters track this, and coverage priorities are reviewed against on-chain activity                                                                                                                      |

## 24. Glossary

- Base reserve: the unit of locked XLM, currently 0.5 XLM (network-voted). An account's minimum balance is two base reserves plus one per subentry, adjusted by sponsorship (`+ numSponsoring - numSponsored`).
- Subentry: a trustline, offer, data entry, or signer attached to an account. Each adds one base reserve to the minimum balance; a pool-share trustline adds two.
- `ACCOUNT_MERGE`: the operation that transfers an account's full XLM balance to a destination and deletes the source account. Requires no subentries apart from signers, and no sponsorships.
- Sponsorship: an arrangement where one account pays the reserve for another account's entry. A sponsoring account cannot be merged until it stops sponsoring; for most entry kinds this tool revokes the sponsorship automatically when the entry's owner can absorb the shifted reserve, but a sponsored claimable balance has no self-service revocation path (§3) and remains a permanent blocker until claimed.
- Trustline: an account's declared ability to hold a given asset, with a balance and a limit. Removed with `ChangeTrust` set to limit 0 once the balance is zero.
- Stellar RPC: the JSON-RPC interface for live ledger reads (`getLedgerEntries`), Soroban simulation (`simulateTransaction`), submission (`sendTransaction`), confirmation (`getTransaction`), and events (`getEvents`). It cannot enumerate an account's unknown subentries.
- Indexer: a service that indexes ledger history and exposes enumeration, such as the stellar.expert API or a Horizon-compatible provider. The tool reads enumeration from an existing indexer rather than running its own.
- `InvokeHostFunction`: the Stellar operation that calls a Soroban smart contract. Each one is simulated over RPC to determine its footprint, authorization, and resource fee.
- `ScVal`: the value encoding used by Soroban contracts. The tool decodes `ScVal` results when reading on-chain position state.
- `wasmHash`: the hash identifying a deployed contract's code. The tool maps it to a known protocol version to pick the correct exit interface.
- bToken / dToken: Blend's representations of a supply position (bToken) and a debt position (dToken).
- Q4W: Blend's queue-for-withdrawal cooldown on backstop deposits: 21 days on V1 pools, 17 days on V2.
- CDP: a collateralized debt position, the FxDAO model where XLM collateral backs minted stablecoin.
- SAC: the Stellar Asset Contract, which lets a classic asset (and XLM) be used inside Soroban contracts. It implements the SEP-41 token interface.
- Mediator account: a shared, persistent account, funded once by the operator, used to forward funds to a destination that does not support `ACCOUNT_MERGE`, such as an exchange.

## 25. References

- Reference tool, stellar.expert demolisher (Orbit Lens): https://stellar.expert/demolisher/public
- StellarExpert demolisher announcement: https://medium.com/@orbit.lens/stellarexpert-embeddable-blocks-accounts-demolisher-and-other-new-features-931ec41427a1
- Stellar RPC overview and methods: https://developers.stellar.org/docs/data/apis/rpc
- getLedgerEntries reference: https://developers.stellar.org/docs/data/apis/rpc/api-reference/methods/getLedgerEntries
- SDF Horizon retention change (August 2024): https://stellar.org/blog/foundation-news/sdf-s-horizon-limiting-data-to-1-year
- List of operations (ManageSellOffer, ChangeTrust, AccountMerge, SetOptions, PathPaymentStrictSend): https://developers.stellar.org/docs/learn/fundamentals/transactions/list-of-operations
- Minimum balance and base reserve: https://developers.stellar.org/docs/learn/fundamentals/lumens
- Classic liquidity pools (CAP-38): https://developers.stellar.org/docs/learn/fundamentals/liquidity-on-stellar-sdex-liquidity-pools
- Path payments (strict send and receive): https://developers.stellar.org/docs/build/guides/transactions/path-payments
- Blend SDK: https://www.npmjs.com/package/@blend-capital/blend-sdk and https://docs.blend.capital/tech-docs/integrations/integrate-pool
- Blend backstop and Q4W: https://docs.blend.capital/users/backstopping
- Aquarius Soroban functions: https://docs.aqua.network/developers/aquarius-soroban-functions
- Soroswap API: https://docs.soroswap.finance/soroswap-api
- Phoenix contracts: https://github.com/Phoenix-Protocol-Group/phoenix-contracts
- FxDAO vaults: https://fxdao.io/docs/developers/vaults/overview/
- stellar-wallets-kit: https://github.com/Creit-Tech/Stellar-Wallets-Kit
- Stellar Asset Contract: https://developers.stellar.org/docs/tokens/stellar-asset-contract
- SEP-41 token interface: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0041.md
- OctoPos: https://communityfund.stellar.org/project/octopos-defi-position-api-g6i and https://docs.crediolabs.ai/docs/category/octopos
