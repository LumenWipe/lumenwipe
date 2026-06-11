<div align="center">
  <img src="lumenwipe.png" alt="LumenWipe Logo" width="120" /><br /><br />

# LumenWipe

**Close any Stellar account cleanly and recover your locked XLM.**

Non-custodial &nbsp;·&nbsp; Client-side signing &nbsp;·&nbsp; Full Soroban & DeFi support &nbsp;·&nbsp; Open source

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Next.js](https://img.shields.io/badge/Next.js-15-black?logo=next.js)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Stellar](https://img.shields.io/badge/Stellar-Protocol%2025-7B3FE4?logo=stellar&logoColor=white)](https://stellar.org)
[![Bun](https://img.shields.io/badge/Bun-1.3-F9F1E1?logo=bun&logoColor=black)](https://bun.sh)

[**lumenwipe.com**](https://lumenwipe.com) &nbsp;·&nbsp; [**docs.lumenwipe.com**](https://docs.lumenwipe.com)

</div>

---

## What is LumenWipe?

LumenWipe is an open-source, non-custodial web app that walks you through closing a Stellar account from start to finish - automatically. It detects everything that holds your account open (trustlines, DEX offers, DeFi positions, data entries, extra signers), unwinds it step by step, converts leftover tokens to XLM, and merges the account into your destination wallet or exchange address.

Every transaction is built and signed in your browser. Your private keys never leave your device. The backend is read-only and stateless: it aggregates data, it never touches your funds.

> **Built on top of the public-domain [stellar.expert/demolisher](https://stellar.expert/demolisher/public) by Orbit Lens**, extended with full Soroban support, DeFi protocol integration, and a production-grade UX designed for irreversible operations.

---

## The Problem

Stellar has over **10 million accounts on mainnet**, and a large share are stale, abandoned, or locked. Two structural issues cause this:

1. **Every account locks XLM in reserve.** The base reserve is 1 XLM. Each trustline, open offer, data entry, or extra signer adds 0.5 XLM. An account with four trustlines, two offers, one data entry, and one extra signer locks **5 XLM** that the user cannot spend until each entry is removed.

2. **Closing an account manually is hard.** A single leftover subentry causes the final `ACCOUNT_MERGE` to fail. Users must cancel every offer, exit every DeFi position, sell every asset, remove every trustline, and clear every data entry - in the correct order - before the merge will succeed. Miss one and everything reverts.

**Exchanges compound the problem.** No major exchange supports `ACCOUNT_MERGE`. A user sending remaining XLM to a CEX cannot merge directly into the deposit address, so the final 1 XLM base reserve stays permanently locked. LumenWipe solves this with a transparent temporary mediator account.

**DeFi users have no tool at all today.** The existing demolisher has no Soroban support. Any account with a Blend loan, an Aquarius LP position, or a Soroswap pair share cannot be closed with existing tools.

---

## What LumenWipe Does

LumenWipe handles the complete account wind-down in a single guided flow:

| Step                           | What happens                                                                                                          |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| **1. Analyze**                 | Reads all subentries (trustlines, offers, data entries, signers, DeFi positions) and builds an ordered execution plan |
| **2. Normalize signers**       | Removes extra signers and normalizes thresholds so a single key can authorize every remaining step                    |
| **3. Remove data entries**     | Clears `ManageData` entries in batches                                                                                |
| **4. Cancel DEX offers**       | Cancels all open order-book offers, freeing their reserves                                                            |
| **5. Exit AMM & LP positions** | Withdraws from classic liquidity pools and all supported Soroban DeFi protocols                                       |
| **6. Convert assets**          | Swaps every remaining token to XLM via the best available route (Soroswap API or SDEX path payments)                  |
| **7. Remove trustlines**       | Removes all trustlines once their balances are zero                                                                   |
| **8. Merge account**           | Executes `ACCOUNT_MERGE`, directly or via a mediator account for exchange destinations                                |

Additional standalone feature: a **read-only allowance inspector** that shows every token approval your account has granted to DeFi contracts, and lets you revoke them without closing the account.

---

## Supported DeFi Protocols

LumenWipe detects and unwinds positions across the major Soroban DeFi protocols using [OctoPos](https://communityfund.stellar.org/project/octopos-defi-position-api-g6i) (primary) and [Orion](https://communityfund.stellar.org/dashboard/submissions/recPt6cTMzx8XmiNj) (fallback) as the DeFi Position API.

| Protocol        | Position type                               | Exit mechanism                                                      |
| --------------- | ------------------------------------------- | ------------------------------------------------------------------- |
| **Classic DEX** | Order-book offers                           | `ManageSellOffer` / `ManageBuyOffer` (amount = 0)                   |
| **Classic AMM** | Pool-share trustline (CAP-38)               | `LiquidityPoolWithdraw`                                             |
| **Blend**       | Supply (bToken), borrow (dToken), backstop  | `Pool.submit` - repay then withdraw, via `@blend-capital/blend-sdk` |
| **Aquarius**    | AMM LP, AQUA rewards                        | `withdraw`, `claim` via Aquarius contracts                          |
| **Soroswap**    | AMM LP                                      | `remove_liquidity` via Soroswap Router API                          |
| **Phoenix**     | AMM LP, optional stake                      | `withdraw_liquidity`, `unstake` first if staked                     |
| **FxDAO**       | CDP vault (XLM collateral, stablecoin debt) | `pay_debt` then collateral withdrawal                               |

If both DeFi position providers are unavailable, the tool enters a **degraded mode**: classic entries process normally and the user is warned to verify DeFi positions manually - the flow never silently fails.

---

## How It Works

### Execution flow

```
Analyze account
  └── Enumerate subentries (stellar.expert indexer)
  └── Detect DeFi positions (OctoPos → Orion)
        │
        ▼
Build deterministic execution plan
        │
        ▼
For each step:
  Re-read live state (Stellar RPC getLedgerEntries)
  Simulate Soroban steps (Stellar RPC simulateTransaction)
  Show step to user → explicit confirmation
  Sign in browser → submit signed XDR to Stellar RPC
  Poll for confirmation → advance
        │
        ▼
AccountMerge (direct or via mediator for exchanges)
```

The plan is **deterministic**: same account state always produces the same ordered plan, which makes it auditable and testable. Steps are reconciled against on-chain state on resume, so an interrupted session never double-executes a completed step.

### CEX mediator flow

Exchanges don't support `ACCOUNT_MERGE`. LumenWipe uses a transparent temporary mediator account:

```
Source account ──(AccountMerge)──► Mediator account
                                          │
                                   (Payment + memo)
                                          │
                                          ▼
                                   Exchange deposit address
```

The mediator keypair is generated in the browser, used once, and cleared from memory. The 1 XLM that stays as the mediator's base reserve is disclosed upfront. Known exchange destinations are validated against a registry that enforces the correct memo type.

### State machine

The tool holds the entire wind-down as an explicit state machine persisted in IndexedDB (never keys). Users can close the tab and resume - the session is reconciled against on-chain state and completed steps are skipped.

```
Idle → Analyzing → PreflightComplete → StepExecuting ⇄ StepFailed
                                              │
                                       StepConfirmed
                                              │
                                         (repeat)
                                              │
                                          Complete
```

---

## Architecture

The system has three layers. The trust boundary is the browser - signing never leaves the client.

```
┌──────────────────────────────────────────────────────┐
│  Browser (trust boundary - keys never leave)         │
│  Guided UI · Wallet adapter (stellar-wallets-kit)    │
│  Transaction builder (pure TS) · Session (IndexedDB) │
└────────────────────┬─────────────────────────────────┘
                     │ signed XDR ──────────────────────────┐
┌────────────────────▼─────────────────────────────────┐   │
│  Read-only backend (stateless, no keys, no custody)  │   │
│  Account analysis · DeFi adapter (OctoPos / Orion)   │   │
│  Routing service · Mediator factory · Redis cache    │   │
└────────────────────┬─────────────────────────────────┘   │
                     │ read-only                            │
┌────────────────────▼─────────────────────────────────────▼──┐
│  Stellar network & data services                             │
│  Stellar RPC · stellar.expert API · Soroswap API  │
└──────────────────────────────────────────────────────────────┘
```

**Key design decisions:**

- **No bespoke indexer.** Stellar RPC cannot enumerate unknown subentries. LumenWipe reads enumeration from `stellar.expert` (the same layer the reference demolisher uses), re-reads exact on-chain state over RPC immediately before building each transaction, and never signs based on stale data.
- **Pluggable data sources.** Every read source (RPC provider, indexer, routing API, DeFi position API) is behind an adapter. Self-hosters can point the tool at any compatible provider.
- **Soroban exits are simulated before signing.** Every `InvokeHostFunction` is run through `simulateTransaction` to fill in footprint, authorization, and resource fees. The user sees the simulation result before being asked to sign.

---

## Security Model

LumenWipe builds transactions that drain accounts irreversibly. The security design starts from that fact.

| What                    | How it's protected                                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Private key**         | Never transmitted. Wallet path keeps it in the wallet; advanced secret-key mode keeps it in memory only, cleared after each signing operation |
| **Signed transaction**  | Built and submitted entirely client-side; user reviews XDR and confirms before every destructive step                                         |
| **Destination address** | Full-address display, ledger existence check, and explicit confirmation before merge                                                          |
| **Exchange memo**       | Required and validated for known exchange destinations - missing memos block submission                                                       |
| **Backend compromise**  | Cannot move funds (no keys, not in signing path). Wrong read data is caught by on-chain simulation and explicit confirmations                 |
| **XSS**                 | Strict Content Security Policy - no inline scripts, no `unsafe-eval`                                                                          |
| **Supply chain**        | Lockfile-pinned dependencies, audited in CI                                                                                                   |

The codebase undergoes internal security reviews as part of our development process. External security audits will be conducted when possible.

---

## Technology Stack

| Layer          | Choice                                              | Why                                                                                  |
| -------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Frontend       | Next.js 15, TypeScript                              | Open source, self-hostable, type-safe transaction construction                       |
| Stellar SDK    | `@stellar/stellar-sdk` 13                           | Official SDK for classic and Soroban                                                 |
| Wallets        | `stellar-wallets-kit` (SEP-43)                      | One interface across Freighter, xBull, Albedo, LOBSTR, Hana, WalletConnect, and more |
| Network access | Stellar RPC                                         | Live reads, simulation, submission, events - no Horizon dependency                   |
| Enumeration    | `stellar.expert` API                                | Existing production indexer, pluggable                                               |
| Routing        | Soroswap API + SDEX paths                           | Best routes across Soroban and classic venues                                        |
| DeFi detection | OctoPos (primary) / Orion (fallback)                | Funded DeFi Position APIs, dual-provider fallback                                    |
| State          | Zustand + IndexedDB                                 | Resumable sessions, never persists keys                                              |
| Backend        | Read-only Next.js API routes, Redis cache           | Stateless, single deployable service                                                 |
| Testing        | Bun test runner (unit), Playwright (E2E on testnet) | Automated tests never touch mainnet                                                  |

---

## Quick Start

**Requirements:** [Bun](https://bun.sh) 1.3+, Node.js 20+

```bash
# Clone and install
git clone https://github.com/LumenWipe/lumenwipe.git
cd lumenwipe
bun install

# Run in development (testnet by default)
bun dev
```

Open [http://localhost:3000](http://localhost:3000). The tool defaults to Stellar testnet - no real funds are at risk while developing.

### Environment variables

Copy `.env.example` to `.env.local` and configure:

| Variable             | Description                                              |
| -------------------- | -------------------------------------------------------- |
| `STELLAR_RPC_URL`    | Stellar RPC endpoint (testnet or mainnet)                |
| `STELLAR_EXPERT_API` | stellar.expert API base URL                              |
| `REDIS_URL`          | Redis connection string for the read cache               |
| `OCTOPOS_API_KEY`    | OctoPos API key (optional - uses public tier without it) |

### Running tests

```bash
# Unit tests
bun test

# End-to-end tests (Playwright, against testnet)
bun test:e2e

# Type check
bun type-check
```

### Docker

```bash
docker build -t lumenwipe .
docker run -p 3000:3000 --env-file .env.local lumenwipe
```

---

## Documentation

Full technical documentation is hosted at [**docs.lumenwipe.com**](https://docs.lumenwipe.com).

| Document                                                           | Description                                                                                                                                                 |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Executive Summary](docs/executive-summary.md)                     | One-page overview: problem, solution, technical pillars, and delivery plan. Start here.                                                                     |
| [Technical Architecture](docs/architecture.md)                     | Complete system design: data sources, execution plan, Soroban & DeFi integration, mediator flow, security, testing, and roadmap. Includes Mermaid diagrams. |
| [Community & Communications](docs/community-and-communications.md) | Building in the open, update cadence, decentralized social channels, and post-launch maintenance.                                                           |

Diagram sources (Mermaid) live in [`docs/diagrams/`](docs/diagrams/) for export to Whimsical, Excalidraw, or image formats.

---

## Delivery Roadmap

The project is delivered in three cumulative tranches, each a working and independently verifiable artifact:

| Tranche                      | Focus                                                                                                                                                                                                               | Status          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| **1 - Classic MVP**          | Full classic wind-down on testnet: signer normalization, data entries, offer cancellation, classic liquidity pool withdrawal, asset conversion, trustline removal, merge, mediator flow, multisig, session recovery | **In progress** |
| **2 - Soroban & DeFi**       | DeFi position detection via OctoPos + Orion; Blend, Aquarius, Soroswap, Phoenix, and FxDAO exits; Soroban token conversion; allowance inspector; per-step simulation                                                | Planned         |
| **3 - Production hardening** | Mainnet deployment, performance validation, final UX from user testing, complete public documentation                                                                                                               | Planned         |

> The classic wind-down already runs. The current codebase builds and signs classic transactions client-side and executes the full path - signer normalization, offer cancellation, asset conversion, trustline removal, and `AccountMerge` including the mediator flow - on both testnet and mainnet.

---

## Community & Contributing

LumenWipe is open source from day one. The full frontend, read-only backend, transaction construction layer, contract registry, and test suite are public.

**Channels:**

| Channel                                                                     | Use                                                  |
| --------------------------------------------------------------------------- | ---------------------------------------------------- |
| [GitHub Issues](https://github.com/LumenWipe/lumenwipe/issues)              | Bug reports, feature requests, roadmap               |
| [LumenWipe Discord](https://discord.gg/b37CPB7g)                            | Community chat, support, and project discussion      |
| [Matrix - #lumenwipe:matrix.org](https://matrix.to/#/#lumenwipe:matrix.org) | Project discussion (open, decentralized)             |
| Telegram                                                                    | Real-time community chat, support, and announcements |

**Contributing:** open an issue or pull request. The contract and exchange registries (versioned JSON) are especially easy to contribute to - new exchange addresses and protocol contract versions are reviewed pull requests, not code changes.

---

## License

[Apache 2.0](LICENSE) - permissive, allows reuse and self-hosting, includes a patent grant.

This project builds upon the open-source work of [stellar.expert/demolisher](https://stellar.expert/demolisher/public) by Orbit Lens.

---

<div align="center">
  <sub>
    <a href="https://lumenwipe.com">lumenwipe.com</a> &nbsp;·&nbsp;
    <a href="https://docs.lumenwipe.com">docs.lumenwipe.com</a>
  </sub>
</div>
