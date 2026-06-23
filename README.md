<div align="center">
  <img src="lumenwipe.png" alt="LumenWipe Logo" width="120" /><br /><br />

# LumenWipe

**Close any Stellar account cleanly and recover your locked XLM.**

Non-custodial &nbsp;·&nbsp; Client-side signing &nbsp;·&nbsp; Soroban & DeFi support &nbsp;·&nbsp; Open source

[![Web app](https://img.shields.io/badge/Web_app-lumenwipe.com-0B6E8F?style=flat-square&labelColor=1b2330)](https://lumenwipe.com)
[![Docs](https://img.shields.io/badge/Docs-docs.lumenwipe.com-3d444d?style=flat-square&labelColor=1b2330)](https://docs.lumenwipe.com)
[![Built on Stellar](https://img.shields.io/badge/Built_on-Stellar-FFFFFF?style=flat-square&labelColor=1b2330&logo=stellar&logoColor=white)](https://stellar.org)
[![License](https://img.shields.io/badge/License-Apache_2.0-30363d?style=flat-square&labelColor=1b2330)](LICENSE)

</div>

---

## What is LumenWipe?

LumenWipe is an open-source, non-custodial web app that walks you through closing a Stellar account from start to finish - automatically. It detects everything holding your account open (trustlines, DEX offers, DeFi positions, data entries, extra signers), unwinds it step by step, converts leftover tokens to XLM, and merges the account into your destination wallet or exchange address.

**Every transaction is built and signed in your browser. Your private keys never leave your device.** The backend is read-only and stateless: it aggregates data and can never move funds.

> **Status:** the classic account wind-down runs today on testnet and mainnet. Soroban & DeFi protocol exits, the allowance inspector, and sponsored fees are in active development — see the [roadmap](#delivery-roadmap).

---

## The Problem

Stellar has over **10 million accounts on mainnet**, and a large share are stale, abandoned, or locked. Two structural issues cause this:

**1. Every account locks XLM in reserve.** The minimum balance is 1 XLM (two base reserves of 0.5 XLM), and each trustline, open offer, data entry, or extra signer adds another 0.5 XLM. An account with four trustlines, two offers, one data entry, and one extra signer locks **5 XLM** that cannot be spent until each entry is individually removed.

**2. Closing an account manually is hard.** A single leftover subentry causes the final `ACCOUNT_MERGE` to fail. Users must cancel every offer, exit every DeFi position, sell every asset, remove every trustline, and clear every data entry - in the correct order - before the merge succeeds. Miss one and everything reverts.

**Exchanges compound the problem.** No major exchange supports `ACCOUNT_MERGE`. Sending remaining XLM to a CEX deposit address still leaves the 1 XLM minimum balance permanently locked. LumenWipe solves this with a shared mediator account and an atomic forwarding payment.

**DeFi users have no tool at all.** The existing demolisher has no Soroban support. Any account with a Blend loan, an Aquarius LP position, or a Soroswap pair share cannot be closed with existing tools.

---

## Architecture

The system has three layers. The trust boundary is the browser - signing never leaves the client.

![System architecture diagram](docs/diagrams/output/01-system-architecture.svg)

**Browser (trust boundary)** - The guided UI, wallet adapter, and a pure-TypeScript transaction builder all live in the browser. The signer receives unsigned envelopes, presents them for review, and sends signed XDR directly to Stellar RPC. The session is persisted to IndexedDB; keys are never stored.

**Read-only backend** - Stateless Next.js API routes aggregate account data, detect DeFi positions, build routing quotes, and construct the mediator's unsigned forwarding transaction. The backend holds no keys and is not in the signing path. A backend compromise cannot move funds.

**Stellar network and data services** - Stellar RPC for live reads, simulation, submission, and events; `stellar.expert` API for subentry enumeration; Soroswap Aggregator API for conversion routing; OctoPos for DeFi position detection.

**Key design decisions:**

- **No bespoke indexer.** Stellar RPC cannot enumerate unknown subentries. LumenWipe reads enumeration from `stellar.expert`, re-reads exact on-chain state over RPC immediately before building each transaction, and never signs based on stale data.
- **Pluggable data sources.** Every read source (RPC provider, indexer, routing API, DeFi position API) is behind an adapter, so any compatible provider can be swapped in without touching the transaction logic.
- **Soroban exits are simulated before signing.** Every `InvokeHostFunction` is run through `simulateTransaction` to fill in footprint, authorization, and resource fees. The user sees the simulation result before being asked to sign.

---

## How It Works

### Execution plan

LumenWipe builds a **deterministic, ordered execution plan** from the account's live state. The same account state always produces the same plan - which makes it auditable and unit-testable. Steps are reconciled against on-chain state on resume, so an interrupted session never double-executes a completed step.

![Ordered execution plan](docs/diagrams/output/06-execution-plan.svg)

| Step | Operation | Details |
| ---- | --------- | ------- |
| **1. Normalize signers** | `SetOptions` | Removes extra signers, normalizes thresholds to 0/1/1 so a single key can authorize all remaining steps |
| **2. Remove data entries** | `ManageData` | Clears all `ManageData` entries in batches of 100 |
| **3. Claim claimable balances** | `ClaimClaimableBalance` | Optional; claims any claimable balances before conversion |
| **4. Cancel DEX offers** | `ManageSellOffer` / `ManageBuyOffer` | Sets amount to 0 on all open order-book offers, freeing reserves |
| **5. Withdraw AMM & LP positions** | `LiquidityPoolWithdraw` + Soroban calls | Classic CAP-38 pools and all supported Soroban protocol exits |
| **6. Exit DeFi protocols** | Soroban `InvokeHostFunction` | Blend, Phoenix, FxDAO: repay debt then withdraw collateral |
| **7. Convert assets** | `PathPaymentStrictSend` / Soroban swaps | Every non-XLM balance converted to XLM via the best available route |
| **8. Remove trustlines** | `ChangeTrust` (limit 0) | Removes all trustlines once their balances are zero, batched by 100 |
| **9. Merge account** | `AccountMerge` | Direct merge, or via mediator account for exchange destinations |

### Session state machine

The entire wind-down is held as an explicit state machine persisted to IndexedDB. Users can close the tab at any point and resume - completed steps are skipped, never re-executed.

![Demolish flow state machine](docs/diagrams/output/03-state-machine.svg)

### Signing flow

Every step follows the same pattern: build unsigned envelope → present for review → sign in browser → submit → poll to confirmation → advance.

![Transaction signing flow](docs/diagrams/output/04-signing-flow.svg)

### CEX mediator flow

Exchanges don't support `ACCOUNT_MERGE`. LumenWipe routes the merge through a shared mediator account in a single atomic transaction sequence:

![Mediator flow for exchange destinations](docs/diagrams/output/09-mediator-flow.svg)

The mediator is a persistent account funded once by the operator and reused for every close. You recover essentially all of your XLM; only standard network fees apply. The merge half is signed in your browser. The backend co-signs only the mediator's forward payment, after validating the exact transaction shape, and cannot alter the destination or amount. Known exchange destinations are validated against a registry that enforces the correct memo type - a missing memo blocks submission.

---

## Supported DeFi Protocols

LumenWipe detects and unwinds positions across the major Soroban DeFi protocols using [OctoPos](https://communityfund.stellar.org/project/octopos-defi-position-api-g6i) as the DeFi Position API.

![DeFi adapter and fallback logic](docs/diagrams/output/05-defi-adapter-fallback.svg)

| Protocol | Position type | Exit mechanism |
| -------- | ------------- | -------------- |
| **Classic DEX** | Order-book offers | `ManageSellOffer` / `ManageBuyOffer` (amount = 0) |
| **Classic AMM** | Pool-share trustline (CAP-38) | `LiquidityPoolWithdraw` |
| **Blend** | Supply (bToken), borrow (dToken), backstop | `Pool.submit` - repay then withdraw, via `@blend-capital/blend-sdk` |
| **Aquarius** | AMM LP, AQUA rewards | `withdraw`, `claim` via Aquarius contracts |
| **Soroswap** | AMM LP | `remove_liquidity` via Soroswap Router API |
| **Phoenix** | AMM LP, optional stake | `withdraw_liquidity`, `unstake` first if staked |
| **FxDAO** | CDP vault (XLM collateral, stablecoin debt) | `pay_debt` then collateral withdrawal |

If the DeFi position provider is unavailable, the tool enters **degraded mode**: classic entries process normally and the user is warned to verify DeFi positions manually. The flow never silently fails or skips a position.

### Asset conversion routing

![Asset conversion and routing](docs/diagrams/output/08-asset-conversion-routing.svg)

All non-XLM balances are converted using the best available route: the Soroswap Aggregator API (which spans both Soroban AMMs and the classic SDEX), with SDEX path payments as the fallback. Every conversion is quoted, slippage-bounded, and simulated before the user is asked to sign.

---

## Security Model

LumenWipe builds transactions that drain accounts irreversibly. The security design starts from that fact.

| What | How it's protected |
| ---- | ------------------ |
| **Private key** | Never transmitted. Wallet path keeps it in the wallet; advanced secret-key mode keeps it in memory only, cleared after each signing operation |
| **Signed transaction** | Built and submitted entirely client-side; user reviews XDR and confirms before every destructive step |
| **Destination address** | Full-address display, ledger existence check, and explicit confirmation before merge |
| **Exchange memo** | Required and validated for known exchange destinations - missing memos block submission |
| **Backend compromise** | Cannot move funds (no keys, not in signing path). Wrong read data is caught by on-chain simulation and explicit confirmations |
| **XSS** | Strict Content Security Policy - no inline scripts, no `unsafe-eval` |
| **Supply chain** | Lockfile-pinned dependencies, audited in CI |

The codebase undergoes internal security reviews as part of the development process. External security audits will be conducted when possible.

---

## Technology Stack

| Layer | Choice | Why |
| ----- | ------ | --- |
| Frontend | Next.js 15, TypeScript | Open source, type-safe transaction construction |
| Stellar SDK | `@stellar/stellar-sdk` | Official SDK for classic and Soroban |
| Wallets | `stellar-wallets-kit` (SEP-43) | One interface across Freighter, xBull, Albedo, LOBSTR, Hana, WalletConnect, and more |
| Network access | Stellar RPC | Live reads, simulation, submission, events |
| Enumeration | `stellar.expert` API + Horizon-compatible endpoints | Existing production indexers, pluggable |
| Routing | Soroswap API + SDEX paths | Best routes across Soroban and classic venues |
| DeFi detection | OctoPos | Funded DeFi Position API, behind a pluggable adapter |
| State | Zustand + IndexedDB | Resumable sessions, never persists keys |
| Backend | Read-only Next.js API routes, Redis cache | Stateless, single deployable service |
| Testing | Bun test runner (unit), Playwright (E2E on testnet) | Automated tests never touch mainnet |

---

## Quick Start

**Requirements:** [Bun](https://bun.sh) 1.3+

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

Copy `.env.example` to `.env.local`. The minimum to run on testnet is the `NEXT_PUBLIC_STELLAR_RPC_*` endpoints; everything else has sensible defaults or is only needed for specific features.

| Variable                                                              | Description                                                                    |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `NEXT_PUBLIC_STELLAR_RPC_TESTNET` / `NEXT_PUBLIC_STELLAR_RPC_MAINNET`  | Stellar RPC endpoints (testnet required for local dev)                         |
| `NEXT_PUBLIC_PATH_ROUTING_API_TESTNET` / `_MAINNET`                    | Horizon-compatible endpoints for offers, full account state, and path finding  |
| `NEXT_PUBLIC_MEDIATOR_PUBLIC_TESTNET` / `_MAINNET`                     | Public key of the shared exchange mediator account                             |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN`                               | Vercel KV — only needed for the merge-stats counter                            |

See `.env.example` for the full list, including operator-only secrets.

### Running tests

```bash
# Unit tests
bun run test

# End-to-end tests (Playwright, against testnet)
bun run test:e2e

# Type check
bun run type-check
```

---

## Documentation

Full technical documentation is at [**docs.lumenwipe.com**](https://docs.lumenwipe.com).

| Document | Description |
| -------- | ----------- |
| [Executive Summary](docs/executive-summary.md) | One-page overview: problem, solution, technical pillars, and delivery plan |
| [Technical Architecture](docs/architecture.md) | Complete system design: data sources, execution plan, Soroban & DeFi integration, mediator flow, security, testing, and roadmap |
| [Community & Communications](docs/community-and-communications.md) | Building in the open, update cadence, decentralized social channels, and post-launch maintenance |
| [Diagram sources](docs/diagrams/) | All 9 Mermaid diagram sources with rendered PNG/SVG exports |

---

## Delivery Roadmap

The project is delivered in three cumulative tranches, each independently verifiable:

| Tranche                      | Focus                                                                                                                                                                                                               | Status          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| **1 - Classic MVP**          | Full classic wind-down on testnet: signer normalization, data entries, offer cancellation, classic liquidity pool withdrawal, asset conversion, trustline removal, merge, mediator flow, multisig, session recovery | **In progress** |
| **2 - Soroban & DeFi**       | DeFi position detection via OctoPos; Blend, Aquarius, Soroswap, Phoenix, and FxDAO exits; Soroban token conversion; allowance inspector; per-step simulation; sponsored fees for reserve-locked accounts            | Planned         |
| **3 - Production hardening** | Security review and remediation, performance validation, final UX from user testing, complete public documentation, public REST API and TypeScript SDK for integrators                                               | Planned         |

> The classic wind-down already runs. The current codebase builds and signs classic transactions client-side and executes the full path - signer normalization, offer cancellation, asset conversion, trustline removal, and `AccountMerge` including the mediator flow - on both testnet and mainnet.

---

## Community & Contributing

LumenWipe is open source from day one. The full frontend, read-only backend, transaction construction layer, contract registry, and test suite are public.

| Channel | Use |
| ------- | --- |
| [GitHub Issues](https://github.com/LumenWipe/lumenwipe/issues) | Bug reports, feature requests, roadmap |
| [LumenWipe Discord](https://discord.gg/b37CPB7g) | Community chat, support, and project discussion |
| [Matrix - #lumenwipe:matrix.org](https://matrix.to/#/#lumenwipe:matrix.org) | Project discussion (open, decentralized) |
| [Telegram - t.me/lumenwipe](https://t.me/lumenwipe) | Real-time community chat, support, and announcements |

**Contributing:** open an issue or pull request. The contract and exchange registries (versioned JSON) are especially easy to contribute to - new exchange addresses and protocol contract versions are reviewed pull requests, not code changes.

---

## License

[Apache 2.0](LICENSE) - permissive, allows reuse, includes a patent grant.

This project builds upon the open-source work of [stellar.expert/demolisher/public](https://stellar.expert/demolisher/public) by Orbit Lens.

---

<div align="center">
  <sub>
    <a href="https://lumenwipe.com">lumenwipe.com</a> &nbsp;·&nbsp;
    <a href="https://docs.lumenwipe.com">docs.lumenwipe.com</a>
  </sub>
</div>
