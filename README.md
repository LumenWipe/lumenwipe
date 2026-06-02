# LumenWipe

A production-ready, open-source tool for cleanly and safely closing Stellar accounts. LumenWipe automates every step required to wind down a Stellar account: unwinding DeFi positions, removing trustlines and data entries, revoking extra signers, converting remaining assets, and merging the account to a destination wallet or exchange address.

## Overview

Stellar accounts accumulate reserves over time. Each trustline, open offer, data entry, and additional signer locks 0.5 XLM in the ledger reserve. Users who abandon accounts or consolidate wallets lose access to these reserves because the manual account-closure process is multi-step, technically involved, and inaccessible to most users. CEXes compound the problem further: none of the major exchanges support the `ACCOUNT_MERGE` operation, so the final 1 XLM base reserve is effectively frozen.

LumenWipe solves this by providing a guided, non-custodial, client-side-signed tool that handles the entire account wind-down process in a single interface. It extends the public-domain work of `stellar.expert/demolisher` with full Soroban support, DeFi protocol integration, and a production-grade UX designed for irreversible operations.

## Documentation

The canonical, consolidated technical reference is the architecture document. It is written to be hosted (GitBook, Whimsical, or equivalent) and linked from the SCF submission.

| Document | Description |
|---|---|
| [Executive Summary](docs/executive-summary.md) | One-page overview: problem, solution, why us, technical pillars, RFP fit, and delivery. Start here. |
| [Technical Architecture](docs/architecture.md) | Consolidated architecture: problem, system design, data sources, the execution plan, Soroban and DeFi integration, mediator flow, security, decentralization, infrastructure, testing, and roadmap. Includes Mermaid diagrams. |
| [RFP Compliance Matrix](docs/rfp-compliance.md) | Every Account Demolisher and RFP Track requirement mapped to where it is addressed. |
| [Community and Communications](docs/community-and-communications.md) | Building in the open, update cadence, decentralized social presence, and post-launch maintenance. |

Diagram sources (Mermaid, also embedded in the architecture document) live in [docs/diagrams/](docs/diagrams/) for export to Whimsical, Excalidraw, or image formats.

## Quick Start

Full setup and local development instructions are available in [docs/architecture.md](docs/architecture.md).

## License

Apache 2.0. This project builds upon the open-source work published at `stellar.expert/demolisher` by Orbit Lens.
