---
title: "Executive summary"
description: "One-page overview: problem, solution, technical pillars, and delivery."
icon: "file-lines"
---

LumenWipe is an open-source, non-custodial tool that cleanly closes a Stellar account and returns its locked XLM to the user. It unwinds everything that holds an account open (trustlines, offers, data entries, extra signers, liquidity pool shares, and DeFi positions), converts whatever is left to XLM, and merges the account into a destination wallet or exchange. It extends the public-domain [stellar.expert/demolisher/public](https://stellar.expert/demolisher/public) by Orbit Lens with the piece that tool lacks: full Soroban and DeFi support.

## The problem

Stellar has more than ten million accounts on mainnet, and a large share are stale, abandoned, or effectively locked. Every account holds XLM in reserve (a 1 XLM minimum balance, which is two base reserves, plus 0.5 XLM per trustline, offer, data entry, or signer), and that reserve is only recoverable by closing the account. Closing one cleanly is a manual, multi-step process most users cannot perform: a single leftover entry makes the final `ACCOUNT_MERGE` fail. Exchanges make it worse, because none support `ACCOUNT_MERGE`, so the base reserve stays frozen for anyone trying to cash out to a CEX. DeFi users have no tool at all today, since the existing demolisher has no Soroban support.

## What we build

A guided web app that runs the whole wind-down in one flow and signs every transaction in the browser. The headline difference from the reference tool is closing positions across the main Soroban DeFi protocols (Blend, Aquarius, Soroswap, Phoenix, FxDAO) on top of all classic operations, plus a CEX-compatible merge, a read-only allowance inspector for revoking risky token approvals, and a UX designed for irreversible actions. Two capabilities widen who can use it: sponsored fees close accounts that hold only their locked reserves and cannot pay their own transaction fees, and a REST API plus a TypeScript SDK let wallets and platforms run the same wind-down programmatically, from a single account to a fleet.

## Why us

The classic wind-down already runs. The current codebase reads account state over Stellar RPC, the stellar.expert API, and Horizon-compatible endpoints, builds and signs classic transactions client-side, and executes the full path (signer normalization, data entry removal, offer cancellation, asset conversion via SDEX path payments, trustline removal, and `AccountMerge`, including the mediator flow for exchange destinations), with unit and end-to-end tests. We are extending a working foundation, not starting from a blank page.

## How it works

Analyze the account, generate a deterministic ordered plan, execute it step by step with explicit confirmation, then merge. A full close is several sequential transactions, so the tool shows the complete plan up front and simulates each step before asking for a signature.

## Technical pillars

- Non-custodial by construction. A user's private keys never leave the browser. The backend is read-only apart from one signing key, the shared exchange mediator, which can only co-sign a forwarding payment the user already authorized in an atomic transaction; no operator (including us) can move a user's account funds or close their account.
- No bespoke indexer. Stellar RPC reads live state, simulates, and submits; existing indexers (the stellar.expert API and Horizon-compatible endpoints) handle enumeration and classic path finding; OctoPos provides DeFi position detection.
- Per-protocol exit adapters and a versioned contract registry. Detect positions with the DeFi Position API, build the exit with each protocol's SDK, public API, or contract, and simulate before signing. A protocol upgrade is a registry update, not a rewrite.
- CEX compatibility through a shared mediator account and an atomic forwarding payment, since exchanges do not support `ACCOUNT_MERGE`. The user recovers essentially all of their XLM.
- Safety for irreversible operations. Per-step confirmation, simulation before signing, resumable sessions reconciled against on-chain state, and security reviews throughout development.

## What it covers

- The full account wind-down: sponsorship and multisig checks, signer and threshold normalization, trustline, data entry, offer, and DeFi position removal, claimable balances, asset conversion, and merge with the mediator flow.
- Consumes a funded DeFi Position API recipient, OctoPos, behind a pluggable adapter with an explicit degraded mode.
- Open source under Apache 2.0, with a REST API and TypeScript SDK so wallets and platforms can integrate the same wind-down.

## Delivery

| Tranche                 | Focus                                                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Classic MVP          | Full classic wind-down on testnet, the mediator flow, multisig, session recovery. Largely built today.                                                                    |
| 2. Soroban and DeFi     | Position detection via OctoPos; Blend, Aquarius, Soroswap, Phoenix, and FxDAO exits; Soroban conversion; allowance inspector; sponsored fees for reserve-locked accounts. |
| 3. Production hardening | Security review and remediation, mainnet deployment, performance validation, final documentation; public REST API and TypeScript SDK for integrators.                     |

## Read more

- [Technical architecture](/architecture): the full design, with diagrams.
- [Community and communications](/community-and-communications): building in the open, update cadence, maintenance.
