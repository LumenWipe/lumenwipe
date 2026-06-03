---
title: "RFP compliance matrix"
sidebarTitle: "RFP compliance"
description: "Every Account Demolisher and RFP Track requirement, mapped to where it is addressed."
icon: "circle-check"
---

This document maps every requirement of the Account Demolisher RFP, and every requirement of the SCF RFP Track, to where and how LumenWipe addresses it. It is a companion to the [technical architecture](/architecture) and exists so a reviewer can check coverage at a glance.

RFP source: [Account Demolisher, SCF Handbook RFP Track, Q2 2026](https://stellar.gitbook.io/scf-handbook/scf-awards/build-award/rfp-track).

## 1. Account Demolisher requirements

Each row quotes or paraphrases a requirement from section 3 of the RFP and points to where it is covered.

| RFP requirement                                                                                                       | How it is addressed                                                                                                                                             | Where                                                          |
| --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Check for existing sponsorships; a sponsoring account cannot be merged                                                | Pre-flight detects sponsorship relationships and blocks the merge with an explanation, preventing `ACCOUNT_MERGE_IS_SPONSOR`                                    | Architecture Section 3, Section 8                              |
| Check for multisig on the account                                                                                     | Pre-flight reads thresholds and signers, detects when multiple signatures are required, and routes into the signer-setup flow                                   | Architecture Section 6.1, Section 6.3                          |
| Check signature scheme and thresholds; remove extra signers and set thresholds to allow further steps                 | Step 1 of the plan: `SetOptions` removes each extra signer (weight 0) and sets low/medium/high thresholds to 0/1/1                                              | Architecture Section 8                                         |
| Remove all trustlines                                                                                                 | `ChangeTrust` with limit 0 once a trustline's balance is zero, batched at 100 per transaction                                                                   | Architecture Section 8, Section 10                             |
| Remove data entries                                                                                                   | `ManageData` removal, batched at 100 per transaction                                                                                                            | Architecture Section 8                                         |
| Optionally claim selected claimable balances                                                                          | `ClaimClaimableBalance` for user-selected balances, an optional plan step                                                                                       | Architecture Section 8                                         |
| Close all open positions: DEX offers, AMM/LP stakes, DeFi positions in Blend, Aquarius, Soroswap, and others          | Per-protocol exits: classic offers, classic liquidity pools, Blend, Aquarius, Soroswap, Phoenix, FxDAO, each through its SDK, public API, or contract interface | Architecture Section 9                                         |
| Sell all tokens (classic and Soroban) to a target base asset via best-available routing                               | Conversion through the Soroswap Aggregator API (classic and Soroban) with SDEX strict-send paths as fallback, with a minimum-received bound                     | Architecture Section 10                                        |
| Let the user forward remaining non-XLM balances to a third-party wallet or exchange                                   | The conversion step offers skip-and-forward, and offers return-to-issuer where no route exists                                                                  | Architecture Section 10                                        |
| Merge the account to a destination; use a temporary mediator account because exchanges do not support `ACCOUNT_MERGE` | `AccountMerge` directly, or the mediator flow (merge into mediator, forward via `Payment` with memo) for exchange destinations                                  | Architecture Section 11                                        |
| Provide a way to view active token allowances and authorizations without closing the account                          | Read-only allowance inspector: discovers spenders from events and the contract registry, reads `allowance`, and revokes with `approve(..., 0, ...)`             | Architecture Section 12                                        |
| Soroban support with full parity to classic assets                                                                    | Soroban positions, Soroban token conversion, and `InvokeHostFunction` construction with RPC simulation throughout                                               | Architecture Section 9, Section 10                             |
| UI supports stellar-wallets-kit and direct secret-key input; multisig may require several keypairs or wallets         | stellar-wallets-kit primary path plus an in-memory secret-key advanced mode; sequential signature accumulation for multisig                                     | Architecture Section 6.3, Section 13.2                         |
| Trust-minimized and non-custodial; all signing client-side; secret keys never sent to a server                        | Signing is entirely client-side; the backend is read-only and never receives keys or signed envelopes with key material                                         | Architecture Section 4, Section 13, Section 14                 |
| Safety features: confirmation flows, clear warnings, and a dry-run / preview approach                                 | Per-step confirmations, no auto-submission, full plan view up front, and per-step `simulateTransaction` before each signature                                   | Architecture Section 8, Section 13.3                           |
| Open source, permissive license                                                                                       | Apache 2.0, public repository, built in the open                                                                                                                | This doc Section 3; [community](/community-and-communications) |
| Production-grade UX for irreversible actions                                                                          | Recoverable-first flow, progressive disclosure, destination verification, memo validation, resumable sessions                                                   | Architecture Section 6, Section 13.3, Section 16               |

### The DeFi Position API requirement

The RFP's expected deliverables call for a "backend service using one of the DeFi position API RFP recipients (OctoPos and Orion)." This is a first-class part of the design, not an afterthought.

- The backend integrates both providers behind one adapter interface, with OctoPos as primary and Orion as automatic fallback. See Architecture Section 7.1.
- DeFi position detection across Blend, Aquarius, Soroswap, Phoenix, and FxDAO is sourced from this API rather than from a position indexer the project would otherwise have to build. See Architecture Section 5 and Section 9.
- When both providers are unavailable, the tool enters a clearly signposted degraded mode rather than failing: classic steps proceed, and the user is warned to verify DeFi positions manually. See Architecture Section 7.1.
- The dual-provider design is also the project's answer to single-provider risk: two independent funded providers mean no single position API is a hard dependency. See Architecture Section 14.

## 2. RFP Track requirements

The RFP Track sets requirements on every submission, beyond the specific RFP. Coverage:

| RFP Track requirement                                                                           | How it is addressed                                                                                                                               | Where                                                               |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Address an open RFP directly, with reasoning for any limited scope                              | LumenWipe responds to the Account Demolisher RFP and covers its full requirement set                                                              | This doc Section 1                                                  |
| Why you are a good fit (past dev work, open-source repos)                                       | A working classic wind-down already runs and is the foundation for the Soroban work; the submission carries the team's prior work                 | Architecture Section 20; submission                                 |
| What makes the solution technically strong                                                      | Detection and unwinding separated; per-protocol adapters and a versioned contract registry; live RPC re-reads before signing; client-side signing | Architecture Section 5, Section 9, Section 13                       |
| Clear, testable milestones                                                                      | Three cumulative tranches with explicit, independently verifiable acceptance criteria                                                             | Architecture Section 19                                             |
| How the tool is maintained after launch                                                         | Versioned registry, per-protocol and per-provider adapters, pinned and audited dependencies, a security policy, and a published update cadence    | Architecture Section 18; [community](/community-and-communications) |
| A high-level visual diagram (Mermaid or similar) and a plain-English stack explanation          | Mermaid diagrams throughout, and a plain-English technology stack summary                                                                         | Architecture Section 4 to Section 11, Section 21                    |
| How the project is decentralized, or why not                                                    | Non-custodial by construction; open source and self-hostable as a single Next.js service; pluggable read sources                                  | Architecture Section 14                                             |
| What infrastructure the project runs on                                                         | A single stateless Next.js service (Docker or any Node host), ecosystem RPC, pluggable data services                                              | Architecture Section 15                                             |
| Plans for user tracking and for protecting users                                                | No PII, no account, privacy-preserving and self-hosted analytics or none, no key logging; fund protection through confirmations and verification  | Architecture Section 16, Section 13.3                               |
| Commitment to regular community updates                                                         | A defined update cadence across GitHub, the Stellar Dev Discord, and decentralized channels                                                       | [community](/community-and-communications)                          |
| Use the most recent stable Stellar tech stack                                                   | Latest `@stellar/stellar-sdk`, Stellar RPC, stellar-wallets-kit, current network protocol; versioned adapters track upgrades                      | Architecture Section 15, Section 21                                 |
| Licensing scheme and commitment to building in the open                                         | Apache 2.0, public repository from the start, open issue tracker and roadmap                                                                      | [community](/community-and-communications)                          |
| Consider OSS and decentralized networks (Matrix, Mastodon, BlueSky) for community communication | A decentralized communications plan covering Matrix, Mastodon, and BlueSky alongside the standard channels                                        | [community](/community-and-communications)                          |

## 3. Expected deliverables

| Deliverable                                                            | Status in plan                                                          |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Production-ready web frontend                                          | Tranche 1 (classic) and Tranche 2 (Soroban), hardened in Tranche 3      |
| Backend service using a DeFi Position API recipient (OctoPos or Orion) | Tranche 2: adapter with OctoPos primary and Orion fallback              |
| Documentation                                                          | This architecture set, maintained in the public repository              |
| Test suite including adversarial and edge-case tests                   | All four test tiers across the three tranches (Architecture Section 17) |
| Security audit and remediation (Audit Bank)                            | Tranche 3, before mainnet launch (Architecture Section 13.4)            |
| Licensing                                                              | Apache 2.0                                                              |
